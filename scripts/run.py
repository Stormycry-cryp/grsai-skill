#!/usr/bin/env python3
"""Portable launcher. No host profiles, credentials, or bundled runtime paths."""
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent


def environment_file(args):
    target = ROOT / '.env'
    if '--env-file' in args:
        index = args.index('--env-file')
        if index + 1 >= len(args) or args[index + 1].startswith('--'):
            raise ValueError('--env-file requires an absolute path')
        target = Path(args[index + 1])
        if not target.is_absolute():
            raise ValueError('--env-file requires an absolute path')
    # Reject links instead of resolving them; never overwrite an existing file.
    target = Path(os.path.abspath(target))
    for parent in target.parents:
        if parent.is_symlink():
            raise ValueError('Environment path contains a symbolic link')
    try:
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, 'w') as stream:
            stream.write('GRSAI_API_KEY=\n')
            stream.flush()
            os.fsync(stream.fileno())
    fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('Environment file must be a regular file')
        content = stream.read()
    # Only detect whether init is configured. Node parses dotenv for execution.
    match = re.search(r'^\s*(?:export\s+)?GRSAI_API_KEY\s*=\s*([^\n]*)', content, re.M)
    value = match.group(1).strip() if match else ''
    if value.startswith(('"', "'")):
        value = value[1:].split(value[0], 1)[0].strip()
    else:
        value = value.split('#', 1)[0].strip()
    return str(target), bool(os.environ.get('GRSAI_API_KEY', '').strip() or value)


def find_node():
    candidates = [os.environ.get('GRSAI_NODE'), shutil.which('node')]
    for candidate in dict.fromkeys(item for item in candidates if item):
        try:
            result = subprocess.run([candidate, '--version'], capture_output=True, text=True, timeout=5)
            major = int(result.stdout.strip().lstrip('v').split('.')[0])
            if result.returncode == 0 and major >= 22:
                return candidate
        except (OSError, ValueError, subprocess.TimeoutExpired):
            continue
    return None


def main():
    args = sys.argv[1:]
    help_requested = '--help' in args or '-h' in args
    if help_requested:
        print(json.dumps({'commands': ['init', 'models', 'recommend --request /abs/request.json',
                                     'create --request /abs/request.json --output-dir /abs/output',
                                     'status --jobID UUID', 'wait --jobID UUID --timeout 55'],
                          'options': ['--env-file /absolute/path/.env', '--dns-mode system|cloudflare'],
                          'requirements': ['Node.js 22+', 'npm install'],
                          'message': 'The first call creates a local .env containing only GRSAI_API_KEY.'}))
        return
    allowed_options = {'--request', '--output-dir', '--request-id', '--jobID', '--job-id',
                       '--timeout', '--env-file', '--dns-mode'}
    position = 1
    while position < len(args):
        option = args[position]
        if option == '--dry-run':
            position += 1
        elif option in allowed_options and position + 1 < len(args) and not args[position + 1].startswith('--'):
            position += 2
        else:
            raise ValueError('Unsupported option or missing option value')
    initialized = environment_file(args)
    node = find_node()
    if args and args[0] == 'init' and not help_requested:
        allowed = args == ['init'] or (len(args) == 3 and args[1] == '--env-file')
        if not allowed:
            raise ValueError('init supports only --env-file /absolute/path/.env')
        env_file, configured = initialized
        print(json.dumps({'status': 'configured' if configured else 'configuration_required',
                          'envFile': env_file, 'nodeAvailable': bool(node),
                          'requirements': ['Node.js 22+', 'Run npm install in the Skill directory'],
                          'message': 'Fill GRSAI_API_KEY in the environment file, then run again.'}))
        return
    if not initialized[1]:
        print(json.dumps({'status': 'configuration_required', 'envFile': initialized[0],
                          'nodeAvailable': bool(node), 'requirements': ['Node.js 22+', 'npm install'],
                          'message': 'Fill GRSAI_API_KEY in the environment file, then run again.'}))
        return
    if not node:
        print(json.dumps({'status': 'dependency_required', 'dependency': 'Node.js 22+',
                          'message': 'Install Node.js 22+ on PATH or set GRSAI_NODE.'}))
        sys.exit(1)
    os.execv(node, [node, '--', str(ROOT / 'scripts/grsai.mjs'), *args])


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError):
        print(json.dumps({'error': 'Cannot safely initialize environment file or launcher arguments.'}), file=sys.stderr)
        sys.exit(1)
