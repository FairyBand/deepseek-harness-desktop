"""fork 专用：轮询上游发布 tag，为新版本触发 Copr 构建（不进上游 PR）。

上游 `v*` tag 从上游仓库构建，fork 的 `copr/<版本>-<N>` 打包修复 tag 从 fork 构建。正式版同时
构建 dsh-tauri 与 dsh-tauri-beta，预发布版只构建 dsh-tauri-beta。是否已构建按 Copr 上同一包的
Version-Release 判断，失败的构建同样算已触发，不会每轮重试；要重试请在 Copr 上手动 resubmit。
"""

import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

COPR_API = 'https://copr.fedorainfracloud.org/api_3'
UPSTREAM = os.environ.get('UPSTREAM_REPO', 'dsh-tauri/deepseek-harness-desktop')
FORK = os.environ.get('GITHUB_REPOSITORY', 'FairyBand/deepseek-harness-desktop')
OWNER = os.environ.get('COPR_OWNER', 'fairyband')
PROJECT = os.environ.get('COPR_PROJECT', 'dsh-tauri')
# 低于此版本的历史 tag 一律忽略，避免首轮把上游一百多个旧版本全部触发
MIN_VERSION = os.environ.get('MIN_VERSION', '0.25.1')
DRY_RUN = os.environ.get('DRY_RUN', 'false') == 'true'
SPECS = {'dsh-tauri': '', 'dsh-tauri-beta': 'dsh-tauri-beta.spec'}
SEMVER = re.compile(r'^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$')


def version_key(version):
    match = SEMVER.match(version)
    if match is None:
        return None
    core = tuple(int(part) for part in match.group(1, 2, 3))
    pre = match.group(4)
    return core, 0 if pre else 1, pre or ''


def http(url, data=None, auth=None):
    request = urllib.request.Request(url, method='POST' if data is not None else 'GET')
    request.add_header('Accept', 'application/json')
    if data is not None:
        request.add_header('Content-Type', 'application/json')
        request.data = json.dumps(data).encode()
    if auth is not None:
        request.add_header('Authorization', 'Basic ' + base64.b64encode(auth.encode()).decode())
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def remote_tags(repo, pattern):
    output = subprocess.run(
        ['git', 'ls-remote', '--tags', '--refs', f'https://github.com/{repo}', pattern],
        check=True, capture_output=True, text=True,
    ).stdout
    return [line.split('refs/tags/', 1)[1] for line in output.splitlines()]


def candidates():
    floor = version_key(MIN_VERSION)
    found = []
    for tag in remote_tags(UPSTREAM, 'v*'):
        found.append((tag, tag[1:], 1, UPSTREAM))
    for tag in remote_tags(FORK, 'copr/*'):
        match = re.match(r'^copr/(.+)-(\d+)$', tag)
        if match:
            found.append((tag, match.group(1), int(match.group(2)), FORK))
    result = []
    for tag, version, release, repo in found:
        key = version_key(version)
        if key is None or key < floor:
            continue
        packages = ['dsh-tauri-beta'] if key[1] == 0 else ['dsh-tauri', 'dsh-tauri-beta']
        nvr = f"{version.replace('-', '~')}-{release}"
        result.append((key, release, repo == FORK, tag, repo, nvr, packages))
    return sorted(result)


def built_versions(package):
    versions = set()
    offset = 0
    while True:
        query = urllib.parse.urlencode({
            'ownername': OWNER, 'projectname': PROJECT, 'packagename': package,
            'limit': 100, 'offset': offset,
        })
        items = http(f'{COPR_API}/build/list?{query}')['items']
        for build in items:
            version = (build.get('source_package') or {}).get('version')
            if version:
                versions.add(version)
            elif build['state'] != 'canceled':
                # SRPM 阶段就失败的构建没有版本号，改按当次构建的 committish 记账
                config = http(f"{COPR_API}/build/source-build-config/{build['id']}")
                versions.add('tag:' + config['source_dict'].get('committish', ''))
        if len(items) < 100:
            return versions
        offset += 100


def has_packaging(repo, tag):
    # 只拉 tag 那一层的目录树（不含文件内容），不走 GitHub API，避开未认证限流
    with tempfile.TemporaryDirectory() as scratch:
        git = ['git', '-C', scratch]
        subprocess.run(['git', 'init', '-q', '--bare', scratch], check=True)
        subprocess.run([*git, 'fetch', '-q', '--depth=1', '--filter=blob:none',
                        f'https://github.com/{repo}', f'refs/tags/{tag}'], check=True)
        probe = subprocess.run([*git, 'cat-file', '-e', 'FETCH_HEAD:.copr/Makefile'], capture_output=True)
        return probe.returncode == 0


def main():
    auth = None
    if not DRY_RUN:
        login, token = os.environ.get('COPR_LOGIN'), os.environ.get('COPR_TOKEN')
        if not login or not token:
            sys.exit('COPR_POLL_CREDENTIALS_MISSING: set COPR_LOGIN and COPR_TOKEN secrets')
        auth = f'{login}:{token}'
    built = {package: built_versions(package) for package in SPECS}
    failures = 0
    for _key, _release, _from_fork, tag, repo, nvr, packages in candidates():
        pending = [p for p in packages if nvr not in built[p] and f'tag:{tag}' not in built[p]]
        if not pending:
            continue
        if not has_packaging(repo, tag):
            print(f'::warning::{repo}@{tag} has no .copr/Makefile, skipped (sync upstream and tag copr/<version>-1 instead)')
            continue
        for package in pending:
            print(f'{"[dry-run] " if DRY_RUN else ""}build {package} {nvr} from {repo}@{tag}')
            built[package].add(nvr)
            if DRY_RUN:
                continue
            try:
                build = http(f'{COPR_API}/build/create/scm', data={
                    'ownername': OWNER, 'projectname': PROJECT,
                    'clone_url': f'https://github.com/{repo}', 'committish': tag,
                    'spec': SPECS[package], 'scm_type': 'git', 'source_build_method': 'make_srpm',
                }, auth=auth)
                print(f"  -> https://copr.fedorainfracloud.org/coprs/build/{build['id']}")
            except urllib.error.HTTPError as error:
                failures += 1
                print(f'::error::COPR_BUILD_SUBMIT_FAILED: {package} {tag}: {error.code} {error.read().decode()[:300]}')
    if failures:
        sys.exit(1)


if __name__ == '__main__':
    main()
