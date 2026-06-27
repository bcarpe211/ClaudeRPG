#!/usr/bin/env python3
"""Generate a fully-transparent XCursor theme so labwc/Chromium draw no pointer.

Writes ~/.local/share/icons/transparent/ with a 1x1 transparent cursor under
every common cursor name. Point the session at it with XCURSOR_THEME=transparent
(done by setup.sh / cursor.sh via ~/.config/labwc/environment).

Why this and not CSS or unclutter: the kiosk runs Chromium as a native Wayland
client under labwc. `cursor: none` only hides the pointer once it moves over the
page, which never happens on a kiosk, and unclutter is X11-only. A transparent
compositor cursor theme is the reliable Wayland fix.
"""
import os
import struct

IMAGE_TYPE = 0xFFFD0002


def xcursor_bytes(size: int = 24) -> bytes:
    width = height = 1
    xhot = yhot = 0
    delay = 0
    pixel = b"\x00\x00\x00\x00"  # fully transparent ARGB
    # image chunk: header(9 uint32 = 36 bytes) + pixels
    img = struct.pack(
        "<IIIIIIIII", 36, IMAGE_TYPE, size, 1, width, height, xhot, yhot, delay
    ) + pixel
    # file header: "Xcur" + headersize(16) + version + ntoc(1)
    header = b"Xcur" + struct.pack("<III", 16, 0x10000, 1)
    # TOC: type, subtype(size), position
    position = 16 + 12  # file header + one toc entry
    toc = struct.pack("<III", IMAGE_TYPE, size, position)
    return header + toc + img


NAMES = [
    "default", "left_ptr", "right_ptr", "arrow", "top_left_arrow", "X_cursor",
    "left_ptr_watch", "watch", "wait", "progress", "half-busy",
    "xterm", "text", "vertical-text", "ibeam",
    "hand", "hand1", "hand2", "pointer", "pointing_hand", "grab", "grabbing",
    "openhand", "closedhand", "dnd-none", "dnd-move", "dnd-copy", "dnd-link",
    "crosshair", "cross", "tcross", "cell", "plus",
    "fleur", "move", "all-scroll", "size_all",
    "col-resize", "row-resize", "split_h", "split_v",
    "e-resize", "n-resize", "ne-resize", "nw-resize", "s-resize", "se-resize",
    "sw-resize", "w-resize", "ew-resize", "ns-resize", "nesw-resize", "nwse-resize",
    "sb_h_double_arrow", "sb_v_double_arrow", "h_double_arrow", "v_double_arrow",
    "size_hor", "size_ver", "size_fdiag", "size_bdiag",
    "top_left_corner", "top_right_corner", "bottom_left_corner",
    "bottom_right_corner", "left_side", "right_side", "top_side", "bottom_side",
    "question_arrow", "help", "whats_this", "context-menu",
    "not-allowed", "no-drop", "forbidden", "circle",
    "copy", "alias", "link",
    "zoom-in", "zoom-out", "dotbox", "draft", "pencil", "center_ptr", "up_arrow",
]


def main() -> None:
    theme_dir = os.path.expanduser("~/.local/share/icons/transparent")
    cursors_dir = os.path.join(theme_dir, "cursors")
    os.makedirs(cursors_dir, exist_ok=True)

    with open(os.path.join(theme_dir, "index.theme"), "w") as f:
        f.write("[Icon Theme]\nName=transparent\nComment=Blank cursors for kiosk\n")
    with open(os.path.join(theme_dir, "cursor.theme"), "w") as f:
        f.write("[Icon Theme]\nName=transparent\n")

    data = xcursor_bytes()
    for name in NAMES:
        with open(os.path.join(cursors_dir, name), "wb") as f:
            f.write(data)

    print(f"wrote transparent cursor theme to {theme_dir} ({len(NAMES)} names)")


if __name__ == "__main__":
    main()
