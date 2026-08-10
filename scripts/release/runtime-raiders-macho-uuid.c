#include <errno.h>
#include <fcntl.h>
#include <mach-o/loader.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int read_exact(int descriptor, void *buffer, size_t count, off_t offset) {
    uint8_t *cursor = buffer;
    size_t remaining = count;
    while (remaining > 0) {
        ssize_t amount = pread(descriptor, cursor, remaining, offset);
        if (amount <= 0) return 0;
        cursor += (size_t)amount;
        remaining -= (size_t)amount;
        offset += amount;
    }
    return 1;
}

static int write_exact(int descriptor, const void *buffer, size_t count, off_t offset) {
    const uint8_t *cursor = buffer;
    size_t remaining = count;
    while (remaining > 0) {
        ssize_t amount = pwrite(descriptor, cursor, remaining, offset);
        if (amount <= 0) return 0;
        cursor += (size_t)amount;
        remaining -= (size_t)amount;
        offset += amount;
    }
    return 1;
}

static int hex_nibble(char value) {
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    return -1;
}

static int uuid_offset(int descriptor, off_t file_size, off_t *result) {
    struct mach_header_64 header;
    if (file_size < (off_t)sizeof(header) ||
        !read_exact(descriptor, &header, sizeof(header), 0) ||
        header.magic != MH_MAGIC_64 || header.filetype != MH_EXECUTE ||
        (header.cputype != CPU_TYPE_ARM64 && header.cputype != CPU_TYPE_X86_64) ||
        header.sizeofcmds > (uint64_t)(file_size - (off_t)sizeof(header))) return 0;

    uint8_t *commands = malloc(header.sizeofcmds);
    if (commands == NULL || !read_exact(descriptor, commands, header.sizeofcmds, sizeof(header))) {
        free(commands);
        return 0;
    }
    size_t offset = 0;
    unsigned int matches = 0;
    off_t found = 0;
    for (uint32_t index = 0; index < header.ncmds; index++) {
        if (offset > header.sizeofcmds || header.sizeofcmds - offset < sizeof(struct load_command)) {
            free(commands);
            return 0;
        }
        const struct load_command *command = (const struct load_command *)(commands + offset);
        if (command->cmdsize < sizeof(struct load_command) || command->cmdsize > header.sizeofcmds - offset) {
            free(commands);
            return 0;
        }
        if (command->cmd == LC_UUID) {
            if (command->cmdsize != sizeof(struct uuid_command)) {
                free(commands);
                return 0;
            }
            matches += 1;
            found = (off_t)sizeof(header) + (off_t)offset +
                (off_t)__builtin_offsetof(struct uuid_command, uuid);
        }
        offset += command->cmdsize;
    }
    free(commands);
    if (offset != header.sizeofcmds || matches != 1 || found < 0 ||
        found > file_size - (off_t)sizeof(((struct uuid_command *)0)->uuid)) return 0;
    *result = found;
    return 1;
}

int main(int argc, char **argv) {
    if (argc < 3 || argc > 4) return 64;
    const char *path = argv[1];
    const char *operation = argv[2];
    int writable = strcmp(operation, "--verify") != 0;
    if ((writable && strcmp(operation, "--zero") != 0 && strcmp(operation, "--set-sha256") != 0) ||
        (strcmp(operation, "--set-sha256") == 0 ? argc != 4 : argc != 3)) return 64;

    int descriptor = open(path, (writable ? O_RDWR : O_RDONLY) | O_NOFOLLOW | O_CLOEXEC);
    if (descriptor < 0) return 1;
    struct stat metadata;
    if (fstat(descriptor, &metadata) != 0 || !S_ISREG(metadata.st_mode) ||
        metadata.st_nlink != 1 || metadata.st_uid != getuid()) {
        close(descriptor);
        return 1;
    }
    off_t offset = 0;
    if (!uuid_offset(descriptor, metadata.st_size, &offset)) {
        close(descriptor);
        return 1;
    }

    uint8_t uuid[16];
    if (strcmp(operation, "--zero") == 0) {
        memset(uuid, 0, sizeof(uuid));
    } else if (strcmp(operation, "--set-sha256") == 0) {
        const char *digest = argv[3];
        if (strlen(digest) != 64) { close(descriptor); return 1; }
        for (size_t index = 0; index < sizeof(uuid); index++) {
            int high = hex_nibble(digest[index * 2]);
            int low = hex_nibble(digest[index * 2 + 1]);
            if (high < 0 || low < 0) { close(descriptor); return 1; }
            uuid[index] = (uint8_t)((high << 4) | low);
        }
        for (size_t index = 32; index < 64; index++) {
            if (hex_nibble(digest[index]) < 0) { close(descriptor); return 1; }
        }
        uuid[6] = (uint8_t)((uuid[6] & 0x0fU) | 0x80U);
        uuid[8] = (uint8_t)((uuid[8] & 0x3fU) | 0x80U);
    } else {
        if (!read_exact(descriptor, uuid, sizeof(uuid), offset)) { close(descriptor); return 1; }
        int nonzero = 0;
        for (size_t index = 0; index < sizeof(uuid); index++) nonzero |= uuid[index];
        int valid = nonzero != 0 && (uuid[6] & 0xf0U) == 0x80U && (uuid[8] & 0xc0U) == 0x80U;
        close(descriptor);
        return valid ? 0 : 1;
    }

    int result = write_exact(descriptor, uuid, sizeof(uuid), offset) && fsync(descriptor) == 0;
    close(descriptor);
    return result ? 0 : 1;
}
