# Neorion

**Optimize Your Codebase Context for LLMs.**

Neorion generates a highly compressed, semantic architecture map of your **Next.js (TypeScript)** project. By providing this map to AI coding assistants (Cursor, Claude Code, Antigravity), you can:

*   **Reduce Context Rot**: Give the AI a "bird's eye view" of your entire project structure without flooding the context window.
*   **Save Tokens**: Compresses thousands of lines of file structure into a concise XML/Markdown graph.
*   **Improve Reasoning**: Helps agents understand relationships between Routes, Components, and Hooks instantly.

## Supported Frameworks

*   ✅ **Next.js (App Router)**
*   ✅ **TypeScript**
*   *(More frameworks coming soon)*

## Features

- **Context Optimization**: Generates `codebase_graph.md` optimized for LLM consumption.
- **Interactive Visualization (Beta)**: View your project's architecture as a dynamic node graph. *(Currently in active development)*
- **Auto-Update**: Intelligently watches for file changes and updates the map in real-time.

> [!NOTE]
> The **Interactive Graph** feature is currently in **Beta**. We are actively refining the physics engine and visual representation. Feedback is welcome!

## Installation

1. **Search**: Open the Extensions view in VS Code (`Ctrl+Shift+X`) and search for **"Neorion"**.
   ![Search Neorion](media/install_search.png)

2. **Download**: Click the **Install** button.
   ![Install Neorion](media/install_result.png)

## 🤖 How to use with AI Agents (Cursor, Claude, Antigravity)

**This is the most powerful way to use Neorion.**

1.  **Generate**: Run `Neorion: Generate Architecture Map` to create `codebase_graph.md`.
2.  **Add to Context**:
    *   **Cursor**: Type `@codebase_graph.md` in your chat.
    *   **Claude/Antigravity**: Upload or reference the file.
3.  **Prompting**: Tell the AI to use this map as its "navigation system".

> **Recommended Prompt:**
> "I have added `codebase_graph.md`. This file contains the complete architectural map of this project (Routes -> Components -> Hooks).
> **Always read this file first** to understand the directory structure and component relationships before answering my questions.
> Use it to find where features are located without needing to scan every file."

## Commands

- `Neorion: Generate Architecture Map`: Generates the `codebase_graph.md` file.
- `Neorion: Show Architecture Graph`: Opens the interactive visualization panel.

## Usage

1.  **Open project**: Open your Next.js project in VS Code or Cursor.
2.  **Generate Map**: Press `Cmd+Shift+P` (or `Ctrl+Shift+P`) and run **`Neorion: Generate Architecture Map`**.
    *   This creates a `codebase_graph.md` file in your root directory.
3.  **Visualize**: Run **`Neorion: Show Architecture Graph`**.
    *   An interactive graph of your project structure will appear in a side panel.
4.  **Auto-Update**: Just save any file (`Ctrl+S`), and the map/graph will update automatically!
