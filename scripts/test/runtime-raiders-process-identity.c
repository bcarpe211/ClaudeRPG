#include <errno.h>
#include <libproc.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>

static int fail_for_errno(void) {
    return errno == ESRCH ? 3 : 4;
}

int main(int argc, char **argv) {
    if (argc != 4) return 4;
    char *end = NULL;
    errno = 0;
    long value = strtol(argv[1], &end, 10);
    if (errno != 0 || end == argv[1] || *end != '\0' || value <= 1 || value > INT32_MAX) return 4;
    pid_t pid = (pid_t)value;
    const char *expected_path = argv[2];
    const char *expected_argument = argv[3];
    if (expected_path[0] != '/' || strchr(expected_path, '\n') != NULL ||
        strchr(expected_argument, '\n') != NULL) return 4;

    char path[PROC_PIDPATHINFO_MAXSIZE];
    int path_count = proc_pidpath(pid, path, sizeof(path));
    if (path_count <= 0) return fail_for_errno();
    if ((size_t)path_count >= sizeof(path) || strcmp(path, expected_path) != 0) return 4;

    struct proc_bsdinfo info;
    int info_count = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
    if (info_count != (int)sizeof(info)) return fail_for_errno();

    int mib_argmax[2] = { CTL_KERN, KERN_ARGMAX };
    int argmax = 0;
    size_t argmax_size = sizeof(argmax);
    if (sysctl(mib_argmax, 2, &argmax, &argmax_size, NULL, 0) != 0 || argmax <= 0) return 4;
    char *buffer = calloc(1, (size_t)argmax);
    if (buffer == NULL) return 4;
    int mib_args[3] = { CTL_KERN, KERN_PROCARGS2, pid };
    size_t size = (size_t)argmax;
    if (sysctl(mib_args, 3, buffer, &size, NULL, 0) != 0) {
        int result = fail_for_errno();
        free(buffer);
        return result;
    }
    if (size <= sizeof(int)) { free(buffer); return 4; }
    int argument_count = 0;
    memcpy(&argument_count, buffer, sizeof(argument_count));
    if (argument_count < 1) { free(buffer); return 4; }
    size_t expected_length = strlen(expected_argument);
    size_t expected_argument_count = expected_length == 0 ? 0 : 1;
    for (size_t index = 0; index < expected_length; index++) {
        if (expected_argument[index] != ' ') continue;
        if (index == 0 || index + 1 == expected_length || expected_argument[index - 1] == ' ') {
            free(buffer);
            return 4;
        }
        expected_argument_count++;
    }
    if ((size_t)argument_count != expected_argument_count + 1) { free(buffer); return 4; }
    char *cursor = buffer + sizeof(argument_count);
    char *limit = buffer + size;
    while (cursor < limit && *cursor != '\0') cursor++;
    while (cursor < limit && *cursor == '\0') cursor++;
    if (cursor >= limit || strcmp(cursor, expected_path) != 0) { free(buffer); return 4; }
    cursor += strlen(cursor) + 1;
    const char *expected_cursor = expected_argument;
    for (size_t index = 0; index < expected_argument_count; index++) {
        if (cursor >= limit) { free(buffer); return 4; }
        size_t available = (size_t)(limit - cursor);
        size_t actual_length = strnlen(cursor, available);
        if (actual_length == available) { free(buffer); return 4; }
        const char *separator = strchr(expected_cursor, ' ');
        size_t token_length = separator == NULL
            ? strlen(expected_cursor)
            : (size_t)(separator - expected_cursor);
        if (actual_length != token_length || memcmp(cursor, expected_cursor, token_length) != 0) {
            free(buffer);
            return 4;
        }
        cursor += actual_length + 1;
        expected_cursor += token_length;
        if (separator != NULL) expected_cursor++;
    }
    if (*expected_cursor != '\0') { free(buffer); return 4; }
    free(buffer);

    printf("start=%llu.%06llu\ncommand=%s%s%s\n",
           (unsigned long long)info.pbi_start_tvsec,
           (unsigned long long)info.pbi_start_tvusec,
           expected_path,
           expected_length == 0 ? "" : " ",
           expected_argument);
    return 0;
}
