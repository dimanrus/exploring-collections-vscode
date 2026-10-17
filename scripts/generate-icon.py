#!/usr/bin/env python3
"""Generates the extension icon.

The icon is defined once as a list of vector shapes; the script renders it to
`resources/icon.png` (256x256, anti-aliased via 4x supersampling) and writes the
equivalent `resources/icon.svg`. Keeping both outputs from one description means
the vector and raster versions can never drift apart.

    python3 scripts/generate-icon.py
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
RESOURCES = ROOT / "resources"

SIZE = 256
SCALE = 4
GRADIENT_FROM = (22, 104, 214)
GRADIENT_TO = (123, 63, 242)
HEADER_COLOR = (47, 107, 221)
CARD_COLOR = (255, 255, 255)
LENS_COLOR = (26, 74, 168)
RING_COLOR = (255, 255, 255)
CELL_COLORS = [(223, 231, 251), (201, 216, 247), (238, 243, 254)]


@dataclass
class Shape:
    kind: str
    box: tuple[float, float, float, float] = (0, 0, 0, 0)
    radius: float = 0
    fill: tuple[int, int, int, int] = (0, 0, 0, 255)
    outline: tuple[int, int, int, int] | None = None
    width: int = 0


@dataclass
class Icon:
    background: Shape
    card: list[Shape] = field(default_factory=list)
    header: list[Shape] = field(default_factory=list)
    cells: list[Shape] = field(default_factory=list)
    lens: list[Shape] = field(default_factory=list)


def build_icon() -> Icon:
    card_x, card_y, card_w, card_h = 34, 58, 168, 122
    card_right = card_x + card_w
    card_bottom = card_y + card_h
    header_h = 32
    rows = 3
    row_height = 17
    row_gap = 9
    rows_top = card_y + header_h + 13

    card = [
        Shape("rounded", (card_x + 4, card_y + 6, card_right + 4, card_bottom + 6), 18, (12, 38, 90, 60)),
        Shape("rounded", (card_x, card_y, card_right, card_bottom), 16, (255, 255, 255, 255)),
    ]

    header = [
        Shape("rounded", (card_x, card_y, card_right, card_y + header_h), 16, (*HEADER_COLOR, 255)),
        Shape("rect", (card_x, card_y + header_h / 2, card_right, card_y + header_h), 0, (*HEADER_COLOR, 255)),
    ]

    cells: list[Shape] = []
    cell_layout = [(46, 48), (102, 42), (152, 42)]
    for row in range(rows):
        y = rows_top + row * (row_height + row_gap)
        for column, (x, width) in enumerate(cell_layout):
            color = CELL_COLORS[(row + column) % len(CELL_COLORS)]
            cells.append(Shape("rounded", (x, y, x + width, y + row_height), 5, (*color, 255)))

    lens_center = (176, 164)
    lens_radius = 38
    handle_start = (203, 191)
    handle_end = (226, 214)
    lens = [
        Shape(
            "line",
            (handle_start[0], handle_start[1], handle_end[0], handle_end[1]),
            9,
            (255, 255, 255, 255),
        ),
        Shape(
            "circle",
            (lens_center[0] - lens_radius, lens_center[1] - lens_radius, lens_center[0] + lens_radius, lens_center[1] + lens_radius),
            0,
            (*LENS_COLOR, 232),
        ),
        Shape(
            "ring",
            (lens_center[0] - lens_radius, lens_center[1] - lens_radius, lens_center[0] + lens_radius, lens_center[1] + lens_radius),
            11,
            (255, 255, 255, 255),
            width=11,
        ),
    ]

    return Icon(
        background=Shape("rounded", (14, 14, SIZE - 14, SIZE - 14), 52, (255, 255, 255, 255)),
        card=card,
        header=header,
        cells=cells,
        lens=lens,
    )


def gradient_image() -> Image.Image:
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    pixels = image.load()
    for y in range(SIZE):
        for x in range(SIZE):
            t = (x + y) / (2 * (SIZE - 1))
            pixels[x, y] = (
                round(GRADIENT_FROM[0] + (GRADIENT_TO[0] - GRADIENT_FROM[0]) * t),
                round(GRADIENT_FROM[1] + (GRADIENT_TO[1] - GRADIENT_FROM[1]) * t),
                round(GRADIENT_FROM[2] + (GRADIENT_TO[2] - GRADIENT_FROM[2]) * t),
                255,
            )
    return image


def rounded_mask(size: int, box, radius: float) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle(box, radius=radius, fill=255)
    return mask


def draw_shape(draw: ImageDraw.ImageDraw, shape: Shape, scale: int) -> None:
    box = tuple(value * scale for value in shape.box)
    if shape.kind == "rounded":
        draw.rounded_rectangle(
            box,
            radius=shape.radius * scale,
            fill=shape.fill,
            outline=None,
        )
    elif shape.kind == "rect":
        draw.rectangle(box, fill=shape.fill)
    elif shape.kind == "circle":
        draw.ellipse(box, fill=shape.fill)
    elif shape.kind == "ring":
        draw.ellipse(box, outline=shape.fill, width=max(1, int(shape.width * scale)))
    elif shape.kind == "line":
        x1, y1, x2, y2 = shape.box
        draw.line(
            (x1 * scale, y1 * scale, x2 * scale, y2 * scale),
            fill=shape.fill,
            width=int(shape.radius * 2 * scale),
        )
        # Round caps.
        radius = shape.radius * scale
        for (cx, cy) in ((x1 * scale, y1 * scale), (x2 * scale, y2 * scale)):
            draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=shape.fill)


def render_png(icon: Icon) -> Image.Image:
    scale = SCALE
    canvas = Image.new("RGBA", (SIZE * scale, SIZE * scale), (0, 0, 0, 0))

    background = gradient_image().resize((SIZE * scale, SIZE * scale), Image.NEAREST)
    mask = rounded_mask(SIZE * scale, tuple(v * scale for v in icon.background.box), icon.background.radius * scale)
    canvas.paste(background, (0, 0), mask)

    overlay = Image.new("RGBA", (SIZE * scale, SIZE * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    for shape in [*icon.card, *icon.header, *icon.cells, *icon.lens]:
        draw_shape(draw, shape, scale)
    canvas = Image.alpha_composite(canvas, overlay)
    return canvas.resize((SIZE, SIZE), Image.LANCZOS)


def render_svg(icon: Icon) -> str:
    def color(value: tuple[int, int, int, int]) -> str:
        r, g, b, a = value
        if a == 255:
            return f"#{r:02x}{g:02x}{b:02x}"
        return f"rgba({r},{g},{b},{round(a / 255, 3)})"

    def rect(shape: Shape) -> str:
        x1, y1, x2, y2 = shape.box
        return (
            f'    <rect x="{x1}" y="{y1}" width="{round(x2 - x1, 2)}" height="{round(y2 - y1, 2)}" '
            f'rx="{shape.radius}" fill="{color(shape.fill)}" />'
        )

    background = icon.background.box
    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}" width="{SIZE}" height="{SIZE}" role="img" aria-label="Exploring Collections">',
        '  <defs>',
        '    <linearGradient id="ecBackground" x1="0" y1="0" x2="1" y2="1">',
        f'      <stop offset="0" stop-color="{color((*GRADIENT_FROM, 255))}" />',
        f'      <stop offset="1" stop-color="{color((*GRADIENT_TO, 255))}" />',
        '    </linearGradient>',
        '  </defs>',
        f'  <rect x="{background[0]}" y="{background[1]}" width="{round(background[2] - background[0], 2)}" '
        f'height="{round(background[3] - background[1], 2)}" rx="{icon.background.radius}" fill="url(#ecBackground)" />',
        '  <g>',
    ]
    lines.extend(rect(shape) for shape in icon.card)
    lines.extend(rect(shape) for shape in icon.header)
    lines.extend(rect(shape) for shape in icon.cells)

    handle = icon.lens[0]
    x1, y1, x2, y2 = handle.box
    lines.append(
        f'    <line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color(handle.fill)}" '
        f'stroke-width="{round(handle.radius * 2, 1)}" stroke-linecap="round" />'
    )
    lens = icon.lens[1]
    lx1, ly1, lx2, ly2 = lens.box
    lines.append(
        f'    <circle cx="{round((lx1 + lx2) / 2, 2)}" cy="{round((ly1 + ly2) / 2, 2)}" '
        f'r="{round((lx2 - lx1) / 2, 2)}" fill="{color(lens.fill)}" />'
    )
    ring = icon.lens[2]
    rx1, ry1, rx2, ry2 = ring.box
    lines.append(
        f'    <circle cx="{round((rx1 + rx2) / 2, 2)}" cy="{round((ry1 + ry2) / 2, 2)}" '
        f'r="{round((rx2 - rx1) / 2 - ring.width / 2, 2)}" fill="none" '
        f'stroke="{color(ring.fill)}" stroke-width="{ring.width}" />'
    )
    lines.extend(['  </g>', '</svg>', ''])
    return "\n".join(lines)


def main() -> None:
    RESOURCES.mkdir(parents=True, exist_ok=True)
    icon = build_icon()
    image = render_png(icon)
    png_path = RESOURCES / "icon.png"
    image.save(png_path, "PNG", optimize=True)

    svg_path = RESOURCES / "icon.svg"
    svg_path.write_text(render_svg(icon), encoding="utf8")

    for size in (32, 64, 128):
        image.resize((size, size), Image.LANCZOS).save(RESOURCES / f"icon-{size}.png", "PNG", optimize=True)

    print(f"wrote {png_path.relative_to(ROOT)} ({image.size[0]}x{image.size[1]})")
    print(f"wrote {svg_path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
