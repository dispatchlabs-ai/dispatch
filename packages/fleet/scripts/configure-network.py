#!/usr/bin/env python3
import importlib.util
from pathlib import Path
from common import private_config, load_release

manifest = load_release(private_config()['manifest'])
spec = importlib.util.spec_from_file_location('dispatch_workspace', manifest['workspaceController'])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
controller = module.Controller(Path('/etc/dispatch-fleet/workspace.json'))
controller.network(configure=True)
controller.image(manifest['workspace'])
