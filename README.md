# Markdown Margin

Margin is a local Markdown review skill. It opens a loopback-only browser
preview where a reviewer can select text and submit comments to an agent, which
then applies requested edits using its normal tools.

## Use

The skill is [annotate-markdown](skills/annotate-markdown/SKILL.md). Add that
directory to a compatible agent's skill discovery path and ask it to review a
local Markdown document. The skill describes the workflow, feedback handling,
and optional routing to a specifically chosen live session.

For Chinese instructions, use
[annotate-markdown-cn](skills/annotate-markdown-cn/SKILL.md). Each variant
includes its own scripts, assets, and dependencies and can be installed alone.
The browser interface remains in English.

### Host compatibility

The skills use the shared [Agent Skills](https://github.com/agentskills/agentskills)
`SKILL.md` format, not a host-specific plugin. Skill installation locations and
supported features vary by host; see the guides for
[VS Code](https://code.visualstudio.com/docs/agent-customization/agent-skills),
[GitHub Copilot](https://docs.github.com/en/copilot/concepts/customizations/agent-skills),
[Claude Code](https://code.claude.com/docs/en/skills), and
[Codex](https://developers.openai.com/codex/skills/). Install the complete
directory of the desired variant in a host-supported location.

The workflow requires a local Node.js runtime, a browser able to reach that
runtime's loopback address, and a host that can run and monitor background
commands. The optional cross-session relay also needs compatible session
discovery and messaging tools. These capabilities are host-dependent, and
remote or cloud agent environments may not be able to open the local preview.
End-to-end integration has not been verified across these hosts.

Node.js 22 or later is required. Install the skill-local locked dependencies
when needed:

```sh
npm ci --prefix skills/annotate-markdown --ignore-scripts --no-audit --no-fund
```

For the Chinese variant, use `skills/annotate-markdown-cn` as the prefix
instead. The scripts and assets are duplicated so either skill can be installed
independently; keep both implementations in sync when changing them.

The lockfile uses the public npm registry; access is required unless the
dependencies are already cached.

Run the tests:

```sh
npm test --prefix skills/annotate-markdown
```

CI runs both variants on Windows, Linux, and macOS with Node.js 22.
The POSIX-only permission test is explicitly skipped on Windows.

The preview server binds to loopback. Its URL contains a private capability
token; do not share the URL or session descriptor. It does not publish documents,
load remote images, edit the source directly, or call a model.

Session descriptors are created with mode `0600` on POSIX systems. On Windows,
access depends on inherited filesystem ACLs, not POSIX mode bits; the skill
does not configure ACLs. Use a temporary directory whose ACLs restrict access
to your account when reviewing private documents on a shared machine.
