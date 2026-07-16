#!/usr/bin/env python3
"""Score whether a product image has a white (#ffffff-like) background."""

from __future__ import annotations

import argparse
import io
import json
import sys
import urllib.error
import urllib.request
from typing import Any

from PIL import Image


def is_white(rgb: tuple[int, int, int], threshold: int) -> bool:
    return all(value >= threshold for value in rgb)


def sample_border_points(width: int, height: int) -> list[tuple[int, int]]:
    return [
        (0, 0),
        (width - 1, 0),
        (0, height - 1),
        (width - 1, height - 1),
        (width // 2, 0),
        (width // 2, height - 1),
        (0, height // 2),
        (width - 1, height // 2),
    ]


def score_image_bytes(data: bytes, threshold: int = 240) -> dict[str, Any]:
    image = Image.open(io.BytesIO(data)).convert("RGB")
    width, height = image.size
    points = sample_border_points(width, height)
    colors = [image.getpixel(point) for point in points]
    corner_colors = colors[:4]

    corner_white = all(is_white(color, threshold) for color in corner_colors)
    edge_white_ratio = sum(1 for color in colors if is_white(color, threshold)) / len(colors)
    avg_rgb = [
        sum(color[index] for color in colors) // len(colors)
        for index in range(3)
    ]

    return {
        "whiteBackground": corner_white,
        "edgeWhiteRatio": round(edge_white_ratio, 4),
        "avgRgb": avg_rgb,
        "width": width,
        "height": height,
        "score": round(edge_white_ratio * 100 + (25 if corner_white else 0), 2),
    }


def fetch_image(url: str, timeout: int = 20) -> bytes:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "NXT-Sourcing-Image-Checker/1.0"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--threshold", type=int, default=240)
    args = parser.parse_args()

    try:
        payload = score_image_bytes(fetch_image(args.url), threshold=args.threshold)
        payload["url"] = args.url
        print(json.dumps(payload))
        return 0
    except urllib.error.URLError as error:
        print(json.dumps({"error": str(error), "url": args.url}))
        return 1
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"error": str(error), "url": args.url}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
