// GitHub releases: publishes a project's GitHub releases as its artifacts, and hands their files to its participants
// (artifact.fetch), through their own fetcher (github-checkout, its contract says). All of it with its own GitHub
// access: a token, or its person's GitHub App (Weave signs the App's JWT; the key never reaches this code). Nobody
// else needs GitHub access, or Weave's.
//
// Publishing (maintainers, action publish): it reads the release at a tag and its weave.app.json, matches its files
// to platforms, has Weave fingerprint each (fingerprint() in the WIT) and publishes the artifact. A public repository's
// files are fetched directly by the fetcher; a private one's only through a grant of this service: a download address
// of GitHub's file store for that one file, for a few minutes, sealed to the asker. Its code stays closed.
//
// Only releases its projects' maintainers published count (release() in the WIT), whatever a request names, and the
// asker's Weave checks the file against the release's digest, so nobody has to trust what it grants.
import { answer, fingerprint, me, pinImage, publish, release, setting, sign, token as keyvaultToken } from 'weave:service/host@0.1.0';

const API = 'https://api.github.com';
const PROTOCOL = 'artifact.fetch';
const encode = (text) => new TextEncoder().encode(text);
const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A GitHub API call: its response. */
function github(path, token, init = {}) {
  return fetch(`${API}${path}`, {
    ...init,
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'weave-github-releases', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  });
}

/** Installation tokens of its GitHub App, by account: kept until a few minutes before they run out. */
const installations = new Map();

/** Its GitHub App's token for a repository, if it has an App and the App is installed there. */
async function appToken(repo) {
  const id = setting('GITHUB_APP_ID');
  if (!id) return undefined;
  const owner = repo.split('/')[0].toLowerCase();
  const kept = installations.get(owner);
  if (kept && kept.expires - Date.now() > 5 * 60_000) return kept.token;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))}.${base64url(encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: id })))}`;
  const jwt = `${unsigned}.${base64url(sign('GITHUB_APP_KEY', 'RS256', encode(unsigned)))}`;
  const installed = await github(`/repos/${repo}/installation`, jwt);
  if (installed.status === 404) return undefined;
  if (!installed.ok) throw new Error(`GitHub said ${installed.status} for the App's installation on ${repo}`);
  // A POST with a body of its own: one without never ends its request.
  const minted = await github(`/app/installations/${(await installed.json()).id}/access_tokens`, jwt, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  if (!minted.ok) throw new Error(`GitHub said ${minted.status} for the App's token`);
  const { token, expires_at } = await minted.json();
  installations.set(owner, { token, expires: Date.parse(expires_at) });
  return token;
}

/** Access through its person's GitHub keyvault, for a project and a repository they handed it: read-only, short-lived. */
function fromKeyvault(space, repo) {
  try {
    const token = JSON.parse(keyvaultToken('github', space, [repo])).token;
    refused.delete(repo);
    return token;
  } catch (error) {
    refused.set(repo, String(error?.message ?? error).slice(0, 300));
    return undefined;
  }
}

/** Why Weave gave it no keyvault access to a repository the last time it asked: said along when GitHub then shows nothing. */
const refused = new Map();

/** What to say when GitHub shows nothing of a repository to it without access. */
const withoutAccess = (repo) => `: a private repository comes through the GitHub keyvault of whoever runs this service (Keys & devices), handed to this project by an app made for its owner and installed on it${refused.has(repo) ? ` (the keyvault: ${refused.get(repo)})` : ''}`;

/** Its access to a repository for a project: its person's keyvault's, its own App's, a sign-in, or a token; none for public repositories only. */
const accessTo = async (space, repo) => fromKeyvault(space, repo) ?? (await appToken(repo)) ?? setting('GITHUB') ?? setting('GITHUB_TOKEN');

/** A release by its tag, as GitHub has it: its files and whether its repository is public. */
async function releaseAt(repo, tag, token) {
  const res = await github(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, token);
  if (res.status === 404) throw new Error(`GitHub shows no release ${tag} in ${repo}${token ? ' that it may see' : withoutAccess(repo)}`);
  if (!res.ok) throw new Error(`GitHub said ${res.status} for ${repo} ${tag}`);
  return res.json();
}

/** GitHub's download address of a release file: a redirect to its file store, which works for a while without access. */
async function downloadAddress(repo, id, token) {
  const res = await github(`/repos/${repo}/releases/assets/${id}`, token, { headers: { accept: 'application/octet-stream' }, redirect: 'manual' });
  const url = res.headers.get('location');
  if (res.status < 300 || res.status >= 400 || !url) throw new Error(`GitHub said ${res.status} instead of a download address`);
  return url;
}

/** Which platform a release file is for, from its name (Gameshow-1.4-win-x64.zip → win32-x64), as Weave guesses it. */
function guessPlatform(name) {
  const n = name.toLowerCase();
  if (/(^|[^a-z0-9])wasm([^a-z0-9]|$)/.test(n)) return 'wasm';
  const parts = new Set(n.split(/[^a-z0-9]+/));
  const has = (...words) => words.some((w) => parts.has(w));
  const os = has('mac', 'macos', 'darwin', 'osx', 'dmg') ? 'darwin' : has('win', 'windows', 'win32', 'win64', 'exe', 'msi') ? 'win32' : has('linux', 'appimage', 'deb') ? 'linux' : undefined;
  if (!os) return undefined;
  const arch = has('arm64', 'aarch64') ? 'arm64' : has('x64', 'amd64', 'win64') || /x86_64/.test(n) ? 'x64' : has('ia32', 'x86', 'i386') ? 'ia32' : os === 'darwin' && has('universal') ? 'arm64' : 'x64';
  return `${os}-${arch}`;
}

/** Publish a release as the project's artifact: its app (weave.app.json at the tag), or one of its files. */
async function publishRelease(space, input) {
  const repo = String(input?.source ?? input?.repo ?? '');
  const tag = String(input?.tag ?? '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('which repository holds the release? (owner/name: Weave says it when you publish from the project)');
  if (!tag) throw new Error('which release? (its tag, like v1.0)');
  const token = await accessTo(space, repo);
  const info = await github(`/repos/${repo}`, token);
  if (!info.ok) throw new Error(info.status === 404 ? `GitHub shows no ${repo}${token ? ' that it may see' : withoutAccess(repo)}` : `GitHub said ${info.status} for ${repo}`);
  // Public: its files are anyone's, so fetchers get them directly. Private: only through a grant of this service.
  const access = (await info.json()).private ? 'grant' : 'direct';
  const found = await releaseAt(repo, tag, token);
  const pin = async (file) => {
    const { sha256, size } = JSON.parse(fingerprint(await downloadAddress(repo, file.id, token)));
    return { file: file.name, sha256, size };
  };

  // A file of the release, handed out as it is.
  if (input.file) {
    const file = found.assets.find((a) => a.name === input.file);
    if (!file) throw new Error(`the release ${found.tag_name} has no file ${input.file}`);
    const name = String(input.name ?? file.name).slice(0, 40);
    const app = name.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'file';
    const manifest = { app, name, version: 1, services: [], file: input.type ? { type: String(input.type) } : {}, install: { source: { provider: 'github', ref: repo }, fetcher: 'github-checkout', tag: found.tag_name, access, assets: { file: await pin(file) } } };
    const item = JSON.parse(publish(space, 'weave.artifact', JSON.stringify(manifest)));
    return { text: `${name} ${found.tag_name} is available`, data: { id: item.id, manifest } };
  }

  // The artifact: as weave.app.json says at the tag, or as described before.
  const content = await github(`/repos/${repo}/contents/weave.app.json?ref=${encodeURIComponent(found.tag_name)}`, token);
  let app;
  if (content.ok) {
    const body = await content.json();
    // Base64 of its bytes, UTF-8 (atob alone reads them as Latin-1: "groÃe" for "große").
    app = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(String(body.content ?? '').replace(/\s/g, '')), (c) => c.charCodeAt(0))));
  } else if (input.previous) app = input.previous;
  else throw new Error(`${repo} has no weave.app.json at ${found.tag_name}: add one (app, name, services, start), tag again, and publish`);
  // The same artifact as released from this source before (another is another source's, or a new one).
  if (input.previous && input.previous.app !== app.app) throw new Error(`${repo} at ${found.tag_name} holds the artifact "${app.app}", but what's released from ${repo} so far is "${input.previous.app}"`);

  // Which file is for which platform: as given, or guessed from the names.
  const chosen = new Map();
  if (input.assets && Object.keys(input.assets).length) {
    for (const [platform, name] of Object.entries(input.assets)) {
      const file = found.assets.find((a) => a.name === name);
      if (!file) throw new Error(`the release ${found.tag_name} has no file ${name}`);
      chosen.set(platform, file);
    }
  } else for (const file of found.assets) {
    const platform = guessPlatform(file.name);
    if (platform && !chosen.has(platform)) chosen.set(platform, file);
  }
  // Its container image, pinned by its digest: tagged like the release (v1.2.0, or 1.2.0).
  let image;
  if (app.start?.image) {
    try {
      image = { ref: app.start.image, ...JSON.parse(pinImage(app.start.image, [...new Set([found.tag_name, found.tag_name.replace(/^v(?=\d)/, '')])])) };
    } catch (error) {
      if (!chosen.size) throw error;
    }
  }
  if (!chosen.size && !image) throw new Error(found.assets.length ? `no file in ${found.tag_name} says which computer it's for (win, mac, linux or wasm in its name): name them in assets` : `${found.tag_name} in ${repo} has no build files attached: Weave installs build files from a release (GitHub's source archives don't count)`);
  const assets = {};
  for (const [platform, file] of chosen) assets[platform] = await pin(file);
  const { image: _image, assets: _assets, github: _github, ...kept } = { ...(input.previous?.install ?? {}), ...(app.install ?? {}) };
  const manifest = { ...app, install: { ...kept, source: { provider: 'github', ref: repo }, fetcher: 'github-checkout', tag: found.tag_name, access, ...(Object.keys(assets).length ? { assets } : {}), ...(image ? { image } : {}) } };
  const item = JSON.parse(publish(space, 'weave.app', JSON.stringify(manifest)));
  return { text: `${app.name} ${found.tag_name} is available`, data: { id: item.id, manifest } };
}

/** The releases of a repository on GitHub, newest first: for picking one to publish. */
async function releasesOf(space, input) {
  const repo = String(input?.source ?? input?.repo ?? '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('which repository? (owner/name)');
  const token = await accessTo(space, repo);
  const res = await github(`/repos/${repo}/releases?per_page=30`, token);
  if (!res.ok) throw new Error(`GitHub said ${res.status} for ${repo}'s releases`);
  const all = await res.json();
  // In its own words (Weave knows no GitHub): where they are, what to do without any, and why one can't be published.
  return {
    data: {
      repo,
      where: `${repo} on GitHub`,
      empty: 'Push a version tag (like v0.1.0) with a release workflow that builds it (weave app workflow), or create a release on GitHub and attach the builds; then come back here.',
      releases: all.filter((r) => !r.draft).map((r) => ({ tag: r.tag_name, name: r.name || r.tag_name, ...(r.published_at ? { published: r.published_at } : {}), files: r.assets.length, prerelease: !!r.prerelease, ...(r.assets.length ? {} : { problem: "no files attached: GitHub's source archives don't count" }) })),
    },
  };
}

/** What it grants for a release's file for a platform: GitHub's address for it, or the release when it's public. */
async function grant(space, data) {
  const found = release(space, String(data.artifact ?? ''));
  if (!found) throw new Error('no such release in this project');
  const { tag, name, manifest } = JSON.parse(found);
  const asset = manifest.install?.assets?.[String(data.platform)];
  if (!asset) throw new Error(`${name} ${tag} has no file for ${data.platform}`);
  const repo = manifest.install?.source?.provider === 'github' ? manifest.install.source.ref : undefined;
  if (!repo) throw new Error(`${name} ${tag} isn't released on GitHub`);
  const release_ = { repo, tag, file: asset.file };
  // Its code is open: the fetcher gets it as it is.
  if (manifest.install.access === 'direct') return release_;
  // Closed: only this service reaches it, and grants one file, for a few minutes. Never the asker's own access.
  const token = await accessTo(space, repo);
  if (!token) throw new Error(`it has no GitHub access for ${repo}: whoever runs it hands ${repo} to this project in their GitHub keyvault (Keys & devices)${refused.has(repo) ? ` (the keyvault: ${refused.get(repo)})` : ''}`);
  const file = (await releaseAt(repo, tag, token)).assets.find((a) => a.name === asset.file);
  if (!file) throw new Error(`the release ${tag} on GitHub has no file ${asset.file}`);
  return { ...release_, url: await downloadAddress(repo, file.id, token) };
}

export async function onEvent(text) {
  const item = JSON.parse(text);
  if (item.kind !== 'weave.service.request') return;
  const body = item.body ?? {};
  try {
    let said;
    if (body.action === 'publish') said = await publishRelease(item.space.id, body.data);
    else if (body.action === 'releases') said = await releasesOf(item.space.id, body.data);
    else if (body.data?.protocol === PROTOCOL) said = { data: await grant(item.space.id, body.data) };
    else throw new Error(`it answers ${PROTOCOL}, publish and releases only`);
    answer(item.id, said.text, said.data === undefined ? undefined : JSON.stringify(said.data), undefined);
  } catch (error) {
    answer(item.id, undefined, undefined, error?.message ?? String(error));
  }
}
