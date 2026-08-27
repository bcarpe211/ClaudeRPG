#ifndef RUNTIME_RAIDERS_SIGNAL_SUPPORT_H
#define RUNTIME_RAIDERS_SIGNAL_SUPPORT_H

#include <stdbool.h>

typedef enum {
    RRS_TEST_PAUSE_DISABLED = 0,
    RRS_TEST_PAUSE_BEFORE_CLAIM = 1,
    RRS_TEST_PAUSE_AFTER_CLAIM = 2,
} rrs_test_pause_stage;

typedef enum {
    RRS_SIGNAL_RESTORE_NOT_STARTED = 0,
    RRS_SIGNAL_RESTORE_COMPLETE = 1,
    RRS_SIGNAL_RESTORE_POISONED = 2,
} rrs_signal_restore_result;

bool rrs_terminal_signal_atomics_are_lock_free(void);
bool rrs_terminal_signal_trap_install(int write_descriptor);
bool rrs_terminal_signal_trap_prepare_restore(void);
rrs_signal_restore_result rrs_terminal_signal_trap_restore(bool *saw_late_signal);
bool rrs_terminal_signal_trap_finish_mask(void);

void rrs_terminal_signal_test_configure(
    rrs_test_pause_stage pause_stage,
    int signal_number,
    int entered_write_descriptor,
    int release_read_descriptor,
    int quiescence_write_descriptor,
    int quiescence_continue_read_descriptor
);
void rrs_terminal_signal_test_fail_install_at(int signal_index);
void rrs_terminal_signal_test_fail_restore_at(int signal_index);
bool rrs_terminal_signal_test_action_is_poisoned(int signal_number);
void rrs_terminal_signal_test_interrupt_partial_rollback(
    int signal_number,
    bool abort_closed_handler
);
void rrs_terminal_signal_test_reset(void);

#endif
