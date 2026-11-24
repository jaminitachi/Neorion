"""Time dub webview actions from input through the next painted frame."""

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


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
