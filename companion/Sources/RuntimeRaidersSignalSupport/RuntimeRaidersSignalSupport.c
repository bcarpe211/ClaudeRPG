#include "RuntimeRaidersSignalSupport.h"

#include <errno.h>
#include <signal.h>
#include <stddef.h>
#include <stdatomic.h>
#include <stdint.h>
#include <unistd.h>

static const int rrs_protected_signals[] = {SIGINT, SIGTERM, SIGHUP, SIGQUIT};
static const size_t rrs_protected_signal_count =
    sizeof(rrs_protected_signals) / sizeof(rrs_protected_signals[0]);

static _Atomic uint32_t rrs_entered_handlers = ATOMIC_VAR_INIT(0);
static _Atomic bool rrs_gate_closed = ATOMIC_VAR_INIT(true);
static _Atomic int rrs_write_descriptor = ATOMIC_VAR_INIT(-1);
static _Atomic bool rrs_late_signal = ATOMIC_VAR_INIT(false);
static struct sigaction rrs_previous_actions[4];
static _Atomic bool rrs_previous_action_ready[4];

static _Atomic int rrs_configured_pause_stage = ATOMIC_VAR_INIT(RRS_TEST_PAUSE_DISABLED);
static _Atomic int rrs_test_signal_number = ATOMIC_VAR_INIT(0);
static _Atomic int rrs_test_entered_write_descriptor = ATOMIC_VAR_INIT(-1);
static _Atomic int rrs_test_release_read_descriptor = ATOMIC_VAR_INIT(-1);
static _Atomic int rrs_test_quiescence_write_descriptor = ATOMIC_VAR_INIT(-1);
static _Atomic int rrs_test_quiescence_continue_read_descriptor = ATOMIC_VAR_INIT(-1);
static _Atomic int rrs_test_install_failure_index = ATOMIC_VAR_INIT(-1);

static int rrs_signal_index(int signal_number) {
    for (size_t index = 0; index < rrs_protected_signal_count; index += 1) {
        if (rrs_protected_signals[index] == signal_number) {
            return (int)index;
        }
    }
    return -1;
}

static bool rrs_write_one(int descriptor, uint8_t byte) {
    if (descriptor < 0) {
        return false;
    }
    ssize_t written = 0;
    do {
        written = write(descriptor, &byte, 1);
    } while (written < 0 && errno == EINTR);
    return written == 1;
}

static void rrs_read_one(int descriptor) {
    if (descriptor < 0) {
        return;
    }
    uint8_t byte = 0;
    while (read(descriptor, &byte, 1) < 0 && errno == EINTR) {}
}

static void rrs_test_pause_if_configured(
    rrs_test_pause_stage stage,
    int signal_number
) {
    if (atomic_load_explicit(&rrs_configured_pause_stage, memory_order_acquire) != stage ||
        atomic_load_explicit(&rrs_test_signal_number, memory_order_relaxed) != signal_number) {
        return;
    }
    rrs_write_one(
        atomic_load_explicit(
            &rrs_test_entered_write_descriptor,
            memory_order_relaxed
        ),
        (uint8_t)stage
    );
    rrs_read_one(
        atomic_load_explicit(&rrs_test_release_read_descriptor, memory_order_relaxed)
    );
}

static void rrs_forward_to_previous_action(int signal_number) {
    int index = rrs_signal_index(signal_number);
    if (index < 0) {
        return;
    }
    atomic_store_explicit(&rrs_late_signal, true, memory_order_release);
    while (!atomic_load_explicit(
        &rrs_previous_action_ready[index],
        memory_order_acquire
    )) {}
    (void)raise(signal_number);
}

static void rrs_terminal_signal_handler(int signal_number) {
    // This must remain the first handler operation. Restore waits for every
    // entry that has crossed this boundary before Swift performs its final drain.
    atomic_fetch_add_explicit(&rrs_entered_handlers, 1, memory_order_acq_rel);
    int caller_errno = errno;
    rrs_test_pause_if_configured(RRS_TEST_PAUSE_BEFORE_CLAIM, signal_number);
    if (atomic_load_explicit(&rrs_gate_closed, memory_order_acquire)) {
        rrs_forward_to_previous_action(signal_number);
        atomic_fetch_sub_explicit(&rrs_entered_handlers, 1, memory_order_release);
        errno = caller_errno;
        return;
    }
    rrs_test_pause_if_configured(RRS_TEST_PAUSE_AFTER_CLAIM, signal_number);
    if (!rrs_write_one(
            atomic_load_explicit(&rrs_write_descriptor, memory_order_relaxed),
            (uint8_t)signal_number
        )) {
        atomic_store_explicit(&rrs_late_signal, true, memory_order_release);
    }
    atomic_fetch_sub_explicit(&rrs_entered_handlers, 1, memory_order_release);
    errno = caller_errno;
}

bool rrs_terminal_signal_atomics_are_lock_free(void) {
    bool lock_free = atomic_is_lock_free(&rrs_entered_handlers) &&
        atomic_is_lock_free(&rrs_gate_closed) &&
        atomic_is_lock_free(&rrs_write_descriptor) &&
        atomic_is_lock_free(&rrs_late_signal) &&
        atomic_is_lock_free(&rrs_configured_pause_stage) &&
        atomic_is_lock_free(&rrs_test_signal_number) &&
        atomic_is_lock_free(&rrs_test_entered_write_descriptor) &&
        atomic_is_lock_free(&rrs_test_release_read_descriptor) &&
        atomic_is_lock_free(&rrs_test_quiescence_write_descriptor) &&
        atomic_is_lock_free(&rrs_test_quiescence_continue_read_descriptor) &&
        atomic_is_lock_free(&rrs_test_install_failure_index);
    for (size_t index = 0; index < rrs_protected_signal_count; index += 1) {
        lock_free = lock_free && atomic_is_lock_free(&rrs_previous_action_ready[index]);
    }
    return lock_free;
}

static void rrs_wait_for_entered_handlers(void) {
    while (atomic_load_explicit(&rrs_entered_handlers, memory_order_acquire) != 0) {}
}

static bool rrs_restore_actions(size_t installed_count) {
    bool restored = true;
    for (size_t index = installed_count; index > 0; index -= 1) {
        size_t action_index = index - 1;
        if (sigaction(
                rrs_protected_signals[action_index],
                &rrs_previous_actions[action_index],
                NULL
            ) != 0) {
            restored = false;
            continue;
        }
        atomic_store_explicit(
            &rrs_previous_action_ready[action_index],
            true,
            memory_order_release
        );
    }
    return restored;
}

static void rrs_test_quiescence_checkpoint(void) {
    int write_descriptor = atomic_load_explicit(
        &rrs_test_quiescence_write_descriptor,
        memory_order_relaxed
    );
    int continue_descriptor = atomic_load_explicit(
        &rrs_test_quiescence_continue_read_descriptor,
        memory_order_relaxed
    );
    if (write_descriptor < 0 || continue_descriptor < 0) {
        return;
    }
    rrs_write_one(write_descriptor, 1);
    rrs_read_one(continue_descriptor);
}

bool rrs_terminal_signal_trap_install(int write_descriptor) {
    if (write_descriptor < 0 || !rrs_terminal_signal_atomics_are_lock_free()) {
        return false;
    }

    atomic_store_explicit(&rrs_write_descriptor, write_descriptor, memory_order_relaxed);
    atomic_store_explicit(&rrs_late_signal, false, memory_order_relaxed);
    for (size_t index = 0; index < rrs_protected_signal_count; index += 1) {
        atomic_store_explicit(
            &rrs_previous_action_ready[index],
            false,
            memory_order_relaxed
        );
    }
    atomic_store_explicit(&rrs_gate_closed, false, memory_order_release);

    struct sigaction temporary_action = {0};
    temporary_action.sa_handler = rrs_terminal_signal_handler;
    temporary_action.sa_flags = SA_RESTART;
    if (sigemptyset(&temporary_action.sa_mask) != 0) {
        atomic_store_explicit(&rrs_gate_closed, true, memory_order_release);
        atomic_store_explicit(&rrs_write_descriptor, -1, memory_order_relaxed);
        return false;
    }

    size_t installed_count = 0;
    for (; installed_count < rrs_protected_signal_count; installed_count += 1) {
        if (atomic_load_explicit(
                &rrs_test_install_failure_index,
                memory_order_relaxed
            ) == (int)installed_count) {
            break;
        }
        if (sigaction(
                rrs_protected_signals[installed_count],
                &temporary_action,
                &rrs_previous_actions[installed_count]
            ) != 0) {
            break;
        }
    }
    if (installed_count == rrs_protected_signal_count) {
        return true;
    }

    atomic_store_explicit(&rrs_gate_closed, true, memory_order_release);
    (void)rrs_restore_actions(installed_count);
    rrs_wait_for_entered_handlers();
    atomic_store_explicit(&rrs_write_descriptor, -1, memory_order_relaxed);
    return false;
}

bool rrs_terminal_signal_trap_restore(bool *saw_late_signal) {
    bool gate_was_open = !atomic_exchange_explicit(
        &rrs_gate_closed,
        true,
        memory_order_acq_rel
    );
    bool actions_restored = rrs_restore_actions(rrs_protected_signal_count);
    bool restored = gate_was_open && actions_restored;
    rrs_test_quiescence_checkpoint();
    rrs_wait_for_entered_handlers();
    if (saw_late_signal != NULL) {
        *saw_late_signal = atomic_exchange_explicit(
            &rrs_late_signal,
            false,
            memory_order_acq_rel
        );
    }
    atomic_store_explicit(&rrs_write_descriptor, -1, memory_order_relaxed);
    return restored;
}

void rrs_terminal_signal_test_configure(
    rrs_test_pause_stage pause_stage,
    int signal_number,
    int entered_write_descriptor,
    int release_read_descriptor,
    int quiescence_write_descriptor,
    int quiescence_continue_read_descriptor
) {
    atomic_store_explicit(
        &rrs_test_entered_write_descriptor,
        entered_write_descriptor,
        memory_order_relaxed
    );
    atomic_store_explicit(
        &rrs_test_release_read_descriptor,
        release_read_descriptor,
        memory_order_relaxed
    );
    atomic_store_explicit(
        &rrs_test_quiescence_write_descriptor,
        quiescence_write_descriptor,
        memory_order_relaxed
    );
    atomic_store_explicit(
        &rrs_test_quiescence_continue_read_descriptor,
        quiescence_continue_read_descriptor,
        memory_order_relaxed
    );
    atomic_store_explicit(&rrs_test_signal_number, signal_number, memory_order_relaxed);
    atomic_store_explicit(&rrs_configured_pause_stage, pause_stage, memory_order_release);
}

void rrs_terminal_signal_test_fail_install_at(int signal_index) {
    atomic_store_explicit(
        &rrs_test_install_failure_index,
        signal_index,
        memory_order_relaxed
    );
}

void rrs_terminal_signal_test_reset(void) {
    atomic_store_explicit(
        &rrs_configured_pause_stage,
        RRS_TEST_PAUSE_DISABLED,
        memory_order_release
    );
    atomic_store_explicit(&rrs_test_signal_number, 0, memory_order_relaxed);
    atomic_store_explicit(&rrs_test_entered_write_descriptor, -1, memory_order_relaxed);
    atomic_store_explicit(&rrs_test_release_read_descriptor, -1, memory_order_relaxed);
    atomic_store_explicit(&rrs_test_quiescence_write_descriptor, -1, memory_order_relaxed);
    atomic_store_explicit(
        &rrs_test_quiescence_continue_read_descriptor,
        -1,
        memory_order_relaxed
    );
    atomic_store_explicit(&rrs_test_install_failure_index, -1, memory_order_relaxed);
}
