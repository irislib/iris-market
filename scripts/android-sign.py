#!/usr/bin/env python3
"""Sign an attested release APK locally without exporting its signing key.

The Linux builder aligns the unsigned release. This step verifies GitHub's
provenance, then proves signing preserved every application ZIP entry. It never
publishes or substitutes for runtime acceptance of the final signed bytes.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import zipfile

sys.dont_write_bytecode = True
def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value

release = module('alpha_release', 'alpha-release.py')
inputs = module('release_inputs', 'release-build-inputs.py')


def payload(path, signed=False):
    records = {}
    seen = set()
    import hashlib
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        release.require(len(infos) <= 100000 and sum(i.file_size for i in infos) <= 1024**3, 'APK ZIP exceeds its bound')
        for info in infos:
            name = info.filename
            release.require(name not in seen and not name.startswith('/') and '\\' not in name and
                            '..' not in name.split('/'), 'Duplicate or unsafe APK entry')
            seen.add(name)
            signing = name == 'META-INF/MANIFEST.MF' or bool(re.fullmatch(r'META-INF/[^/]+\.(SF|RSA|DSA|EC)', name))
            if signing:
                release.require(signed, 'Signing handoff already contains signature metadata')
                continue
            data = archive.read(info)
            records[name] = {'sha256':hashlib.sha256(data).hexdigest(), 'bytes':len(data),
                             'compression':info.compress_type, 'mode':info.external_attr}
    release.require('AndroidManifest.xml' in records and 'lib/arm64-v8a/libiris_market_app.so' in records,
                    'Expected arm64 Market release payload')
    return records


def verify_handoff(receipt, artifact, tag, commit):
    release.identity(tag, commit)
    expected = release.asset_name(tag, 'android-arm64').removesuffix('.apk')+'.unsigned.apk'
    release.require(artifact.name == expected and receipt.get('asset') == expected and
                    receipt.get('tag') == tag and receipt.get('sourceCommit') == commit and
                    receipt.get('platform') == 'android-arm64' and receipt.get('signed') is False and
                    receipt.get('readyForPublication') is False and receipt.get('sha256') == release.sha256(artifact),
                    'Unsigned handoff does not match this exact source, tag and payload')


def attest(path, commit, stage):
    result = subprocess.run(['gh','attestation','verify',str(path),'--repo','irislib/iris-market',
        '--source-digest',commit,'--signer-digest',commit,'--deny-self-hosted-runners',
        '--signer-workflow','irislib/iris-market/.github/workflows/alpha-build.yml','--format','json'],
        check=True,capture_output=True,text=True)
    (stage/(path.name+'.provenance.json')).write_text(result.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tag',required=True); parser.add_argument('--commit',required=True)
    parser.add_argument('--unsigned',type=Path,required=True); parser.add_argument('--receipt',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True); parser.add_argument('--work',type=Path,required=True)
    parser.add_argument('--java',type=Path,required=True,help='Installed Java 17+; recorded host prerequisite, no installer downloaded')
    args = parser.parse_args(); release.exact_source(args.tag,args.commit)
    receipt=release.read_json(args.receipt); verify_handoff(receipt,args.unsigned,args.tag,args.commit)
    for key in release.REQUIRED_ENV['android-arm64']: release.require(os.environ.get(key),'Missing '+key)
    release.require(args.java.is_absolute() and args.java.is_file(),'Explicit installed Java executable required')
    java = subprocess.check_output([str(args.java),'-version'],stderr=subprocess.STDOUT,text=True)
    version = re.search(r'version "(\d+)',java)
    release.require(version and int(version.group(1)) >= 17,'Java 17 or newer is required')
    release.require(args.work.is_absolute() and not args.work.exists(),'Use a new absolute signing work directory')
    args.work.mkdir(mode=0o700,parents=True)
    attest(args.unsigned,args.commit,args.work); attest(args.receipt,args.commit,args.work)
    before=payload(args.unsigned)
    pins=release.read_json(release.ROOT/'scripts/android-release-inputs.json')
    pin=next(p for p in pins['sdk_linux'] if p['package']=='build-tools;36.0.0')
    archive_pin={**pin,'size':pin['bytes']}
    archive=inputs.download_native(archive_pin,args.work/'build-tools.zip')
    inputs.verify_native(archive,archive_pin)
    with zipfile.ZipFile(archive) as source:
        jars=[entry for entry in source.infolist() if entry.filename.endswith('/lib/apksigner.jar')]
        release.require(len(jars)==1 and 0<jars[0].file_size<32*1024**2,'Expected one bounded pinned APK signer')
        jar=args.work/'apksigner.jar'; jar.write_bytes(source.read(jars[0])); jar.chmod(0o600)
    args.output.mkdir(parents=True,exist_ok=True)
    output=args.output/release.asset_name(args.tag,'android-arm64')
    release.require(not output.exists(),'Never overwrite a signed artifact')
    subprocess.run([str(args.java),'-jar',str(jar),'sign','--ks',os.environ['MARKET_ANDROID_KEYSTORE'],
        '--ks-key-alias',os.environ['MARKET_ANDROID_KEY_ALIAS'],'--ks-pass','env:MARKET_ANDROID_STORE_PASSWORD',
        '--key-pass','env:MARKET_ANDROID_KEY_PASSWORD','--out',str(output),str(args.unsigned)],check=True,capture_output=True)
    checked=subprocess.run([str(args.java),'-jar',str(jar),'verify','--verbose',str(output)],check=True,capture_output=True,text=True)
    release.require(payload(output,signed=True)==before,'Signing changed application payload or executable metadata')
    release.exact_source(args.tag,args.commit)
    evidence={'sourceCommit':args.commit,'tag':args.tag,'unsignedSHA256':release.sha256(args.unsigned),
        'signedSHA256':release.sha256(output),'payloadUnchanged':True,'signed':True,'readyForPublication':False,
        'javaVersion':java.strip(),'javaSHA256':release.sha256(args.java),'signerArchiveSHA256':pin['sha256'],
        'signerSHA256':release.sha256(jar),'verification':checked.stdout.strip()}
    (args.work/'signing-receipt.json').write_text(json.dumps(evidence,indent=2)+'\n')
    print(json.dumps({'asset':output.name,'sha256':evidence['signedSHA256'],'payloadUnchanged':True,'readyForPublication':False}))


if __name__=='__main__':
    try: main()
    except (ValueError,OSError,subprocess.CalledProcessError) as error:
        # Command arguments may include private signing identities or key paths.
        print('Local signing failed: '+(str(error) if not isinstance(error,subprocess.CalledProcessError) else 'verification or signing command failed'),file=sys.stderr)
        sys.exit(1)
