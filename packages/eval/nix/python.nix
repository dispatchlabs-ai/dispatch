# The engine's interpreter for a release: the release's own Python with the engine's locked dependencies on its
# path. The wheels and their hashes are read from engine/uv.lock, so the lockfile governs this build as it governs a
# source checkout, and no Python package set is rebuilt.
{ lib, runCommand, fetchurl, unzip, makeWrapper, python3 }:
let
  lock = builtins.fromTOML (builtins.readFile ../engine/uv.lock);
  locked = builtins.filter (package: package ? wheels) lock.package;
  wheel = package:
    let pure = builtins.filter (candidate: lib.hasSuffix "-none-any.whl" candidate.url) package.wheels;
    in assert lib.assertMsg (pure != [ ]) "${package.name} has no pure-Python wheel in engine/uv.lock; package it before locking it.";
      fetchurl { inherit (builtins.head pure) url; sha256 = lib.removePrefix "sha256:" (builtins.head pure).hash; };
in runCommand "dispatch-eval-python" { nativeBuildInputs = [ unzip makeWrapper ]; } ''
  mkdir -p "$out/lib/site-packages" "$out/bin"
  ${lib.concatMapStringsSep "\n" (package: ''unzip -q ${wheel package} -d "$out/lib/site-packages"'') locked}
  makeWrapper ${python3}/bin/python3 "$out/bin/python3" --prefix PYTHONPATH : "$out/lib/site-packages"
  "$out/bin/python3" -c "import openpyxl"
''
