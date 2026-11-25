"""Check dense dub canvas labels and time actions through the next painted frame."""

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

from graph_label_fit import crowded_pairs, record_labels


def smoke(page, action, trigger, expected):
    elapsed = page.evaluate(f"""async () => {{
        const start = performance.now();
        {trigger}
        // Drain timers queued by the action, then allow the canvas to paint.
        await new Promise(resolve => setTimeout(resolve, 0));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (!({expected})) throw new Error('Expected graph state after ' + {action!r});
        return performance.now() - start;
    }}""")
    print(f"dub {action}: {elapsed:.0f} ms", flush=True)
    assert elapsed < 1000, f"dub {action} took {elapsed:.0f} ms (budget 1000 ms)"


def check_dense_labels(page):
    page.locator("#btn-fit").click()
    page.mouse.move(5, 5)
    record_labels(page)
    view = page.evaluate("() => ({ scale: network.getScale(), position: network.getViewPosition() })")
    target = page.evaluate("""() => {
        const largestDomain = componentClusters.filter(cluster => cluster.domain !== 'other')
            .reduce((largest, cluster) => cluster.count > largest.count ? cluster : largest);
        const root = network.body.data.nodes.get().find(node => node.fullLabel === 'layout /');
        return { heading: largestDomain.domain + ' · ' + largestDomain.count + ' components',
                 id: root.id, label: root.shortLabel };
    }""")

    def labels_at(stage):
        boxes = page.evaluate("() => { network.redraw(); return measuredLabels; }")
        labels = {box["text"] for box in boxes}
        crowded = crowded_pairs(boxes, gap=4)
        print(f"dub {stage}: {len(boxes)} labels, {len(crowded)} pairs under 4px clearance, "
              f"heading={target['heading'] in labels}, root={target['label'] in labels}", flush=True)
        assert not crowded, (stage, crowded)
        return labels

    fitted = labels_at("fit")
    point = page.evaluate("id => network.canvasToDOM(network.getPosition(id))", target["id"])
    assert page.evaluate("point => network.getNodeAt(point)", point) == target["id"], target
    page.evaluate("""() => {
        network.on('hoverNode', ({ node }) => { window.testHoveredNode = node; });
        network.on('blurNode', () => { window.testHoveredNode = undefined; });
    }""")
    canvas = page.locator("#mynetwork canvas").bounding_box()
    page.mouse.move(canvas["x"] + point["x"], canvas["y"] + point["y"])
    page.wait_for_function("id => window.testHoveredNode === id", arg=target["id"])
    hovered = labels_at("hover root at fit")
    assert target["heading"] in fitted, f"Missing cluster heading {target['heading']}"
    assert target["label"] in hovered, f"Missing hovered label {target['label']}"
    assert target["heading"] in hovered, f"Missing cluster heading {target['heading']} on hover"

    page.mouse.move(canvas["x"] + 5, canvas["y"] + 5)
    page.mouse.move(5, 5)
    page.wait_for_function("() => window.testHoveredNode === undefined")
    for factor in (1.6, 2.5):
        page.evaluate("view => network.moveTo(view)", {**view, "scale": view["scale"] * factor})
        assert target["label"] in labels_at(f"{factor}× fit"), f"Missing {target['label']} at {factor}× fit"
    page.locator("#btn-fit").click()


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=["--allow-file-access-from-files"])
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(Path(sys.argv[1]).resolve().as_uri() + "?theme=dark")
        page.wait_for_function("() => !network.physics.physicsEnabled", timeout=120_000)
        assert page.evaluate("window.__fixtureCounts.routes") >= 300, "Expected the dub fixture"
        assert page.evaluate("network.body.nodeIndices.some(id => network.isCluster(id))")

        check_dense_labels(page)
        smoke(page, "select", """
            const input = document.getElementById('search-input');
            input.value = 'layout';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        """, "!document.getElementById('details').hidden && network.getSelectedNodes().length === 1")
        for mode in ("routes", "graph"):
            smoke(page, f"switch to {mode}", f"document.getElementById('mode-{mode}').click();",
                  f"document.getElementById('mode-{mode}').getAttribute('aria-pressed') === 'true'")
        smoke(page, "expand all", "document.getElementById('btn-clusters').click();",
              "!network.body.nodeIndices.some(id => network.isCluster(id))")
        assert not errors, errors


if __name__ == "__main__":
    main()
