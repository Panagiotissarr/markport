# Plugins

Two unrelated things share the word:

1. **The sync plugin** — ships with Oryn, installed into a vault.
2. **System plugins** — pre-seeded *into a deployment*, so every visitor gets
   them without installing anything.

## The sync plugin

Download the zip from [Releases](https://github.com/Panagiotissarr/oryn/releases)
and unpack it so the two files sit directly in the folder:

```
<vault>/.obsidian/plugins/markport-neon-sync/
    main.js
    manifest.json
```

Then enable it in Obsidian → Settings → Community plugins.

> **The folder name is frozen: `markport-neon-sync`.** It predates the Oryn
> rename and it stays. Renaming it would strand every existing install, and
> nothing in the plugin depends on the project's display name.

Configuration lives in
`<vault>/.obsidian/plugins/markport-neon-sync/data.json` — backend URL and
token. See [Sync](Sync).

## System plugins

A *system* plugin is seeded into the deployment itself, so a visitor opens the
vault with it already present. That's a different mechanism from normal
Obsidian plugins: they live in the repository under
`src/client-mobile/system-plugins/` and are copied into the build.

The full guide — six steps, the difference from normal plugins, the iterative
loop — is
[system-plugin-dev-guide.md](https://github.com/Panagiotissarr/oryn/blob/main/docs/system-plugin-dev-guide.md).

Seeding at runtime is controlled by environment variables on the server side:

| Variable | Meaning |
|---|---|
| `SYSTEM_PLUGINS_SEED` | comma list — seeded **and** enabled |
| `SYSTEM_PLUGINS_SEED_DISABLED` | comma list — seeded but **not** enabled |

## What the frozen identifiers are

Worth knowing before editing anything in this area, because they look like old
names and are not:

- plugin id and folder: `markport-neon-sync`
- storage keys: `ow-*`
- globals: `__ow*`
- routes: `/sync/v1/*`

Renaming any of them is a breaking change for existing vaults. The CodeRabbit
config in the repository tells reviewers the same thing.
