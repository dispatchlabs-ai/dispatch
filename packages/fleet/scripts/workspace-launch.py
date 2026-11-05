#!/usr/bin/env python3
"""Launch the fixed fleet host from this run's immutable application release."""
import json
import os
from pathlib import Path
import sys
from common import load_release, valid_run

assignment = json.loads((Path(os.environ['CREDENTIALS_DIRECTORY']) / 'assignment').read_text())
if assignment['run'] != valid_run(sys.argv[1]): raise ValueError('Assignment identity mismatch')
manifest = load_release(assignment['release']['manifest'])
tools = manifest['fleet']['tools']
os.execv(tools['node'], [tools['node'], tools['host']])
