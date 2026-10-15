#!/usr/bin/env python3
"""The inter-step artifact contains identifiers only; it is never sourced as shell code."""
from __future__ import annotations
import json
import os
import re
import sys
from pathlib import Path

def validate(data: dict[str, object], app: str, commit: str, build: str) -> dict[str, object]:
    if data.get('app') != app or data.get('commit') != commit or str(data.get('build')) != build:
        raise ValueError('Artifact does not belong to this service, commit and pipeline build')
    expected=f'local/{app}-tested:{commit}-{build}'
    if data.get('image') != expected or not re.fullmatch(r'sha256:[a-f0-9]{64}', str(data.get('image_id',''))):
        raise ValueError('Invalid tested image reference or image ID')
    return data

def main() -> None:
    action, app=sys.argv[1:3]
    commit=os.environ['BITBUCKET_COMMIT'];build=os.environ['BITBUCKET_BUILD_NUMBER']
    if app not in ('roko','bridge') or not re.fullmatch(r'[a-f0-9]{40}',commit) or not re.fullmatch(r'[0-9]{1,12}',build):
        raise ValueError('Invalid service or Bitbucket identifiers')
    if action=='write':
        data={'app':app,'commit':commit,'build':int(build),'image':sys.argv[3],'image_id':sys.argv[4]}
        print(json.dumps(validate(data,app,commit,build)))
    elif action=='read':
        data=validate(json.loads(Path('ci-result.json').read_text()),app,commit,build)
        print(data['image']);print(data['image_id'])
    else:
        raise ValueError('Unknown manifest operation')

if __name__=='__main__':
    main()
