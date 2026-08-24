"""Generate the Windows assets from the Octomynd dashboard mark.

The source geometry intentionally mirrors ui/src/components/OctoMark.tsx. The
generated files are checked in because electron-builder and NSIS need static
assets when a clean checkout is packaged.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"
SCALE = 4
ICON_SIZE = 1024


def map_point(x: float, y: float) -> tuple[int, int]:
    return (round((112 + x * 4) * SCALE), round((112 + y * 4) * SCALE))


def cubic(
    p0: tuple[float, float],
    p1: tuple[float, float],
    p2: tuple[float, float],
    p3: tuple[float, float],
    steps: int = 24,
) -> list[tuple[int, int]]:
    points: list[tuple[int, int]] = []
    for index in range(steps + 1):
        t = index / steps
        u = 1 - t
        x = u**3 * p0[0] + 3 * u**2 * t * p1[0] + 3 * u * t**2 * p2[0] + t**3 * p3[0]
        y = u**3 * p0[1] + 3 * u**2 * t * p1[1] + 3 * u * t**2 * p2[1] + t**3 * p3[1]
        points.append(map_point(x, y))
    return points


def draw_round_path(draw: ImageDraw.ImageDraw, points: Iterable[tuple[int, int]], color: str, width: int) -> None:
    points = list(points)
    draw.line(points, fill=color, width=width, joint="curve")
    radius = width // 2
    for x, y in (points[0], points[-1]):
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)


def draw_mark(image: Image.Image) -> None:
    draw = ImageDraw.Draw(image)
    body_box = tuple(value * SCALE for value in (112 + 46 * 4, 112 + 34 * 4, 112 + 154 * 4, 112 + 130 * 4))
    draw.ellipse(body_box, fill="#c4622d")

    width = 11 * 4 * SCALE
    draw_round_path(draw, cubic((56, 116), (40, 138), (32, 158), (38, 178)), "#c4622d", width)
    draw_round_path(draw, cubic((144, 116), (160, 138), (168, 158), (162, 178)), "#c4622d", width)
    draw_round_path(draw, cubic((80, 126), (75, 148), (75, 164), (80, 180)), "#9c4d24", width)
    draw_round_path(draw, cubic((120, 126), (125, 148), (125, 164), (120, 180)), "#9c4d24", width)
    draw_round_path(draw, [(map_point(100, 128)), map_point(100, 182)], "#9c4d24", width)

    draw.ellipse(tuple(value * SCALE for value in (112 + 103 * 4, 112 + 59 * 4, 112 + 137 * 4, 112 + 93 * 4)), fill="#c4622d")
    draw.ellipse(tuple(value * SCALE for value in (112 + 111 * 4, 112 + 67 * 4, 112 + 129 * 4, 112 + 85 * 4)), fill="#f3ece1")
    draw.ellipse(tuple(value * SCALE for value in (112 + 115 * 4, 112 + 67 * 4, 112 + 125 * 4, 112 + 79 * 4)), fill="#14110f")
    draw.ellipse(tuple(value * SCALE for value in (112 + 121 * 4, 112 + 69 * 4, 112 + 127 * 4, 112 + 75 * 4)), fill="#f3ece1")

    lid = cubic((103, 76), (106, 60), (134, 58), (137, 76))
    lid += cubic((137, 76), (131, 66), (109, 66), (103, 76))[1:]
    draw.polygon(lid, fill="#c4622d")


def main() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    high = Image.new("RGBA", (ICON_SIZE * SCALE, ICON_SIZE * SCALE), "#14110f")
    draw = ImageDraw.Draw(high)
    draw.rounded_rectangle(
        (8 * SCALE, 8 * SCALE, (ICON_SIZE - 8) * SCALE, (ICON_SIZE - 8) * SCALE),
        radius=190 * SCALE,
        outline="#2a2219",
        width=16 * SCALE,
    )
    draw_mark(high)
    icon = high.resize((ICON_SIZE, ICON_SIZE), Image.Resampling.LANCZOS)

    icon_path = BUILD / "maestro-1024x1024.png"
    ico_path = BUILD / "maestro.ico"
    icon.save(icon_path, "PNG", optimize=True)
    icon.save(ico_path, "ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    header = Image.new("RGB", (150, 57), "#14110f")
    header_icon = icon.resize((48, 48), Image.Resampling.LANCZOS).convert("RGB")
    header.paste(header_icon, (5, 4))
    header.save(BUILD / "installer-header.bmp", "BMP")

    sidebar = Image.new("RGB", (164, 314), "#14110f")
    sidebar_icon = icon.resize((126, 126), Image.Resampling.LANCZOS).convert("RGB")
    sidebar.paste(sidebar_icon, ((164 - sidebar_icon.width) // 2, 34))
    sidebar.save(BUILD / "installer-sidebar.bmp", "BMP")

    print(f"Generated {icon_path.name}, {ico_path.name}, installer-header.bmp and installer-sidebar.bmp")


if __name__ == "__main__":
    main()
