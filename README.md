# github-core-clone-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ocha-works/github-core-clone-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ocha-works/github-core-clone-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single dependency-free Node program (standard library only — no packages, no `git` binary). It keeps a real SHA-1 git object store in memory and serves git smart HTTP (protocol v2 `ls-refs`/`fetch` with shallow support, v0 receive-pack with fast-forward-only ref updates and side-band report-status), the REST v3 surface (repositories, branches, commits, contents, labels, issues, comments, pull requests with three-way-merge and squash), GraphQL v4 (the documents `gh` and github-mcp-server send, introspection, cursor pagination, batching, mutations), and an MCP endpoint (`server/discover` plus the legacy handshake, with the six github-mcp-server tools) — all over one shared store, so an object created on one surface is the same object on every other.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=dev-token node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=d5a50dzy&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
