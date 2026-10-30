#!/usr/bin/env python3
"""Registry artifacts contain identifiers only and are never sourced as shell code."""
from __future__ import annotations
import json
import os
import re
import sys
from pathlib import Path

SHA = r'sha256:[a-f0-9]{64}'


def repository() -> str:
    value = os.environ.get('CI_IMAGE_REPOSITORY', '')
    host = r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?'
    part = r'[a-z0-9]+(?:[._-][a-z0-9]+)*'
    if not re.fullmatch(host + r'/' + part + r'(?:/' + part + r')+', value):
        raise ValueError('Set CI_IMAGE_REPOSITORY to registry/namespace/image, without a tag')
    if '.' not in value.split('/')[0] and ':' not in value.split('/')[0]:
        raise ValueError('Registry hostname must be explicit, e.g. docker.io or ghcr.io')
    return value


def validate(data: object, app: str, commit: str, build: str) -> dict:
    if not isinstance(data, dict):
        raise ValueError('Artifact must be a JSON object')
    if data.get('app') != app or data.get('commit') != commit or str(data.get('build')) != build:
        raise ValueError('Artifact does not belong to this service, commit and pipeline build')
    if not re.fullmatch(SHA, str(data.get('image_id', ''))):
        raise ValueError('Invalid image configuration ID')
    if data.get('source') != 'github-actions' or not re.fullmatch(re.escape(repository()) + '@' + SHA, str(data.get('image', ''))):
        raise ValueError('Deployment requires a cloud-tested image pinned by digest in the configured registry')
    return data


def normalized_repository(value: str) -> str:
    return value.removeprefix('docker.io/')


def main() -> None:
    action, app = sys.argv[1:3]
    commit = os.environ['GITHUB_SHA']
    build = os.environ['GITHUB_RUN_NUMBER']
    if app not in ('roko', 'bridge') or not re.fullmatch(r'[a-f0-9]{40}', commit) or not re.fullmatch(r'[1-9][0-9]{0,11}', build):
        raise ValueError('Invalid service or GitHub Actions identifiers')
    if action == 'repository':
        print(repository())
    elif action == 'read':
        data = validate(json.loads(Path('ci-result.json').read_text()), app, commit, build)
        print(data['image'])
        print(data['image_id'])
    elif action == 'publish':
        repo = repository()
        digests = json.load(sys.stdin)
        if not isinstance(digests, list) or not all(isinstance(item, str) for item in digests):
            raise ValueError('Docker did not return repository digests')
        candidates = {
            item.rsplit('@', 1)[1]
            for item in digests
            if '@' in item and normalized_repository(item.rsplit('@', 1)[0]) == normalized_repository(repo)
        }
        if len(candidates) != 1:
            raise ValueError('The published image does not have one unambiguous digest in the configured repository')
        data = {'source': 'github-actions', 'app': app, 'commit': commit, 'build': int(build),
                'image': repo + '@' + candidates.pop(), 'image_id': sys.argv[3]}
        print(json.dumps(validate(data, app, commit, build)))
    else:
        raise ValueError('Unknown registry manifest operation')


if __name__ == '__main__':
    main()
