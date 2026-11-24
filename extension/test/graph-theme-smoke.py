"""Check the rendered graph colors in both editor themes and after a live switch."""

import hashlib
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


def luminance(color):
    rgb = [value / 255 for value in bytes.fromhex(color.lstrip("#"))]
    linear = [value / 12.92 if value <= .04045 else ((value + .055) / 1.055) ** 2.4 for value in rgb]
    return sum(channel * weight for channel, weight in zip(linear, (.2126, .7152, .0722)))


def check_fills(page, background):
    fills = page.evaluate("""() => network.body.nodeIndices
        .filter(id => !id.startsWith('hub_')).map(id => network.body.nodes[id].options.color.background)""")
    assert fills
    for fill in fills:
        low, high = sorted((luminance(fill), luminance(background)))
        assert (high + .05) / (low + .05) >= 3, (fill, background)
    return fills


def main():
    fixture = Path(sys.argv[1]).resolve().as_uri()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=["--allow-file-access-from-files"])
        pages, hashes, fills, errors = {}, {}, {}, []
        for theme, background in {"dark": "#1e1e1e", "light": "#ffffff"}.items():
            page = pages[theme] = browser.new_page(viewport={"width": 1000, "height": 760})
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(fixture + "?theme=" + theme)
            page.wait_for_function("() => !network.physics.physicsEnabled")
            fills[theme] = check_fills(page, background)
            hashes[theme] = hashlib.sha256(page.screenshot()).digest()
        assert hashes["dark"] != hashes["light"], "Dark and light screenshots have identical SHA-256"
        page = pages["dark"]
        positions = page.evaluate("network.getPositions()")
        page.evaluate("document.body.className = 'vscode-light'")
        page.wait_for_function("() => network.nodesHandler.options.font.color === '#333333'")
        assert check_fills(page, "#ffffff") == fills["light"]
        assert page.evaluate("network.getPositions()") == positions, "Nodes moved during the theme switch"
        assert not errors, errors


if __name__ == "__main__":
    main()
