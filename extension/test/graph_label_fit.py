"""Check the canvas label boxes in the Playwright graph harness."""

import json
from itertools import combinations

from playwright.sync_api import expect


def record_labels(page):
    page.evaluate("""() => {
        if (window.measuredLabels) return;
        window.measuredLabels = [];
        let background;
        network.on('beforeDrawing', () => {
            measuredLabels.length = 0;
            background = undefined;
        });
        const overlay = ctx => ctx.canvas.closest('#mynetwork') &&
            ctx.textBaseline === 'middle' && ctx.textAlign === 'left' &&
            Math.abs(ctx.getTransform().a - devicePixelRatio) < 1e-6;
        const context = CanvasRenderingContext2D.prototype;
        const roundRect = context.roundRect;
        context.roundRect = function (x, y, width, height, ...rest) {
            if (overlay(this)) background = { x, y, width, height };
            return roundRect.call(this, x, y, width, height, ...rest);
        };
        const fillText = context.fillText;
        context.fillText = function (text, x, y, ...rest) {
            if (overlay(this) && text) {
                const m = this.measureText(text);
                const box = {
                    left: x - m.actualBoundingBoxLeft, right: x + m.actualBoundingBoxRight,
                    top: y - m.actualBoundingBoxAscent, bottom: y + m.actualBoundingBoxDescent
                };
                // Include the whole pill as well as the ink, which can overhang with some fonts.
                if (background && x === background.x + 4 && y === background.y + background.height / 2) {
                    box.left = Math.min(box.left, background.x);
                    box.right = Math.max(box.right, background.x + background.width);
                    box.top = Math.min(box.top, background.y);
                    box.bottom = Math.max(box.bottom, background.y + background.height);
                }
                background = undefined;
                measuredLabels.push({ text, ...box, font: this.font,
                    inkHeight: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent });
            }
            return fillText.call(this, text, x, y, ...rest);
        };
        network.redraw();
    }""")


def crowded_pairs(boxes, gap=0):
    return [
        [a["text"], b["text"]]
        for a, b in combinations(boxes, 2)
        if max(a["left"] - b["right"], b["left"] - a["right"],
               a["top"] - b["bottom"], b["top"] - a["bottom"]) + 1e-6 < gap
    ]


def read_fit_boxes(page, output, fixture, theme):
    page.locator("#btn-fit").click()
    read = page.locator('[data-level="Read"]')
    if read.get_attribute("aria-pressed") != "true":
        read.click()
    expect(read).to_have_attribute("aria-pressed", "true")
    page.mouse.move(5, 5)
    record_labels(page)
    boxes = page.evaluate("() => { network.redraw(); return measuredLabels; }")
    assert boxes, f"{fixture} {theme}: no Read labels drawn at fit"
    overlaps = crowded_pairs(boxes)
    crowded = crowded_pairs(boxes, gap=4)
    report = {"boxes": boxes, "overlaps": overlaps, "under4px": crowded}
    (output / f"{fixture}-read-fit-label-boxes-{theme}.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"{fixture} {theme} Read fit: {len(boxes)} labels, {len(overlaps)} overlapping pairs, "
          f"{len(crowded)} pairs under 4px clearance", flush=True)
    return overlaps, crowded


def check_hidden_label_recovery(page, theme):
    page.set_viewport_size({"width": 1100, "height": 700})
    page.locator("#btn-fit").click()
    expect(page.locator('[data-level="Read"]')).to_have_attribute("aria-pressed", "true")
    page.mouse.move(5, 5)
    target = page.evaluate("""() => {
        network.redraw();
        const shown = new Set(measuredLabels.map(label => label.text));
        for (const id of network.body.nodeIndices) {
            const node = network.body.data.nodes.get(id);
            if (!['route', 'layout', 'action'].includes(node?.kind) || shown.has(node.shortLabel)) continue;
            const point = network.canvasToDOM(network.getPosition(id));
            if (network.getNodeAt(point) === id) return { id, point, text: node.shortLabel };
        }
    }""")
    assert target, "Expected a hidden Read label in the narrow SaaS graph"
    canvas = page.locator("#mynetwork canvas").bounding_box()
    page.mouse.move(canvas["x"] + target["point"]["x"], canvas["y"] + target["point"]["y"])
    visible = "text => measuredLabels.some(label => label.text === text)"
    page.wait_for_function(visible, arg=target["text"])
    assert not crowded_pairs(page.evaluate("measuredLabels"), gap=4), "Labels crowd on hover"
    page.mouse.move(canvas["x"] + 5, canvas["y"] + 5)
    page.mouse.move(5, 5)
    page.wait_for_function("text => !measuredLabels.some(label => label.text === text)", arg=target["text"])
    page.evaluate("id => network.moveTo({ scale: 1, position: network.getPosition(id) })", target["id"])
    expect(page.locator('[data-level="Full"]')).to_have_attribute("aria-pressed", "true")
    page.wait_for_function(visible, arg=target["text"])
    assert not crowded_pairs(page.evaluate("measuredLabels"), gap=4), "Labels crowd on zoom"
    print(f"saas-starter {theme}: {target['text']} reappears on hover and zoom", flush=True)
