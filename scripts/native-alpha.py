#!/usr/bin/env python3
"""Build one signed native alpha from accepted source; never upload it.

Requires checksum-verified build inputs and externally provisioned signing state.
Generated bindings/projects remain in a new ignored artifact staging directory.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('alpha_release', Path(__file__).with_name('alpha-release.py'))
release = importlib.util.module_from_spec(spec); spec.loader.exec_module(release)
ROOT = release.ROOT


def run(command, environment):
    # Do not echo commands: signing arguments can identify private local credentials.
    subprocess.run([str(value) for value in command], cwd=ROOT, env=environment, check=True)


def rust(environment, *arguments):
    run([environment.get('CARGO', 'cargo'), *arguments], environment)


def binding_library(cache, host):
    return cache/'release'/('libiris_market_app.dylib' if host.endswith('apple-darwin') else 'libiris_market_app.so')


def bindings(stage, cache, environment, language):
    rust(environment, 'build', '--locked', '--release', '-p', 'iris-market-app', '-p', 'iris-market-bindgen')
    host = subprocess.check_output([environment.get('RUSTC', 'rustc'), '-vV'], env=environment, text=True)
    host = next(line.split(': ', 1)[1] for line in host.splitlines() if line.startswith('host: '))
    rust(environment, 'run', '--locked', '--release', '-p', 'iris-market-bindgen', '--', 'generate', '--library', binding_library(cache, host), '--language', language, '--out-dir', stage/'Bindings', '--config', ROOT/'crates/market-app/uniffi.toml')


def apple_headers(stage):
    headers = stage/'headers'; headers.mkdir()
    shutil.copyfile(stage/'Bindings/IrisMarketCoreFFI.h', headers/'IrisMarketCoreFFI.h')
    shutil.copyfile(stage/'Bindings/IrisMarketCoreFFI.modulemap', headers/'module.modulemap')
    return headers


def apple_project(stage, platform, environment):
    headers = stage/'headers'
    if not headers.is_dir(): apple_headers(stage)
    source = ROOT/('ios' if platform == 'ios-arm64' else 'macos')
    text = (source/'project.yml').read_text()
    replacements = {'- path: Sources': '- path: '+str(ROOT/'ios/Sources'), '- path: Bindings': '- path: '+str(stage/'Bindings'), '- path: UITests': '- path: '+str(ROOT/'ios/UITests'), '- path: ../ios/Sources': '- path: '+str(ROOT/'ios/Sources'), '- path: ../ios/Bindings': '- path: '+str(stage/'Bindings'), 'INFOPLIST_FILE: Info.plist': 'INFOPLIST_FILE: '+str(source/'Info.plist'), 'Frameworks/IrisMarketCore.xcframework': str(stage/'IrisMarketCore.xcframework'), '$(PROJECT_DIR)/.build/headers': str(headers)}
    for old, new in replacements.items(): text = text.replace(old, new)
    # Future source asset catalogs remain relative to the original platform tree.
    text = text.replace('- path: Assets.xcassets', '- path: '+str(source/'Assets.xcassets'))
    project = stage/'project.yml'; project.write_text(text)
    run([environment.get('MARKET_XCODEGEN', 'xcodegen'), 'generate', '--spec', project, '--project', stage], environment)
    return headers


def build_ios(args, stage, cache, environment):
    release.require(sys.platform == 'darwin', 'iOS release requires macOS/Xcode')
    release.require((ROOT/'ios/Assets.xcassets/AppIcon.appiconset/Contents.json').is_file(), 'iOS distribution needs a reviewed AppIcon asset catalog')
    bindings(stage, cache, environment, 'swift')
    environment.update(IPHONEOS_DEPLOYMENT_TARGET='16.0', CFLAGS_aarch64_apple_ios='-miphoneos-version-min=16.0')
    rust(environment, 'build', '--locked', '--release', '-p', 'iris-market-app', '--target', 'aarch64-apple-ios')
    headers = apple_headers(stage)
    run(['xcodebuild', '-create-xcframework', '-library', cache/'aarch64-apple-ios/release/libiris_market_app.a', '-headers', headers, '-output', stage/'IrisMarketCore.xcframework'], environment)
    apple_project(stage, args.platform, environment)
    archive = stage/'IrisMarket.xcarchive'
    run(['xcodebuild', '-project', stage/'IrisMarket.xcodeproj', '-scheme', 'IrisMarket', '-configuration', 'Release', '-destination', 'generic/platform=iOS', '-archivePath', archive, '-derivedDataPath', environment.get('MARKET_IOS_RELEASE_DERIVED_DATA', ROOT/'ios/.build/ReleaseDerivedData'), '-jobs', '2', 'CODE_SIGN_STYLE=Manual', 'CODE_SIGN_IDENTITY='+environment['MARKET_IOS_SIGNING_IDENTITY'], 'DEVELOPMENT_TEAM='+environment['MARKET_APPLE_TEAM_ID'], 'PROVISIONING_PROFILE_SPECIFIER='+environment['MARKET_IOS_PROFILE_UUID'], 'MARKETING_VERSION='+args.tag[1:].split('-')[0], 'CURRENT_PROJECT_VERSION='+str(args.build_number), 'archive'], environment)
    options = {'method': 'app-store-connect', 'destination': 'export', 'signingStyle': 'manual', 'teamID': environment['MARKET_APPLE_TEAM_ID'], 'signingCertificate': environment['MARKET_IOS_SIGNING_IDENTITY'], 'provisioningProfiles': {'to.iris.market': environment['MARKET_IOS_PROFILE_UUID']}, 'testFlightInternalTestingOnly': True, 'uploadSymbols': False, 'manageAppVersionAndBuildNumber': False}
    export_options = stage/'ExportOptions.plist'
    with export_options.open('xb') as stream: plistlib.dump(options, stream)
    export_options.chmod(0o600)
    run(['xcodebuild', '-exportArchive', '-archivePath', archive, '-exportPath', stage/'export', '-exportOptionsPlist', export_options], environment)
    artifacts = list((stage/'export').glob('*.ipa'))
    release.require(len(artifacts) == 1, 'Expected exactly one exported IPA')
    shutil.copyfile(artifacts[0], args.output/release.asset_name(args.tag, args.platform))


def build_macos(args, stage, cache, environment):
    release.require(sys.platform == 'darwin', 'macOS release requires macOS/Xcode')
    environment['MACOSX_DEPLOYMENT_TARGET'] = '14.0'
    bindings(stage, cache, environment, 'swift')
    rust(environment, 'build', '--locked', '--release', '-p', 'iris-market-app', '--target', 'aarch64-apple-darwin')
    apple_project(stage, args.platform, environment)
    derived = Path(environment.get('MARKET_MACOS_RELEASE_DERIVED_DATA', ROOT/'macos/.build/ReleaseDerivedData'))
    run(['xcodebuild', '-project', stage/'IrisMarketMac.xcodeproj', '-scheme', 'IrisMarketMac', '-configuration', 'Release', '-sdk', 'macosx', '-destination', 'generic/platform=macOS', '-derivedDataPath', derived, '-jobs', '2', 'ARCHS=arm64', 'ONLY_ACTIVE_ARCH=YES', 'CODE_SIGN_STYLE=Manual', 'CODE_SIGN_IDENTITY='+environment['MARKET_MACOS_SIGNING_IDENTITY'], 'DEVELOPMENT_TEAM='+environment['MARKET_APPLE_TEAM_ID'], 'ENABLE_HARDENED_RUNTIME=YES', 'MARKET_MACOS_STATIC_LIB='+str(cache/'aarch64-apple-darwin/release/libiris_market_app.a'), 'MARKETING_VERSION='+args.tag[1:].split('-')[0], 'CURRENT_PROJECT_VERSION='+str(args.build_number), 'build'], environment)
    app = derived/'Build/Products/Release/IrisMarket.app'
    run(['codesign', '--verify', '--deep', '--strict', app], environment)
    # Notarization/stapling and exact-archive runtime acceptance remain promotion gates.
    run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', app, args.output/release.asset_name(args.tag, args.platform)], environment)


def build_android(args, stage, cache, environment):
    release.require(sys.platform == 'linux', 'Pinned Android release inputs currently require Linux x64')
    release.require(args.android_inputs is not None, 'Android release requires --android-inputs with its verified installer receipt')
    android = release.read_json(args.android_inputs)
    release.require(android.get('passed') is True and android.get('sourceCommit') == args.commit and android.get('pinsSHA256') == release.sha256(ROOT/'scripts/android-release-inputs.json') and android.get('installerSHA256') == release.sha256(ROOT/'scripts/android-release-inputs.py') and android.get('rustReceiptSHA256') == release.sha256(args.inputs), 'Android input receipt does not match this source and Rust toolchain')
    work = args.android_inputs.resolve().parent
    sdk = work/'sdk'
    release.require(environment.get('ANDROID_HOME') == str(sdk) and environment.get('ANDROID_SDK_ROOT') == str(sdk), 'Android environment differs from verified SDK input')
    java = Path(environment.get('JAVA_HOME', ''))
    release.require(java.is_absolute() and java.is_relative_to(work/'jdk') and (java/'bin/java').is_file(), 'Java environment differs from verified JDK input')
    ndk = sdk/'ndk/28.2.13676358'
    release.require(ndk.is_dir() and (sdk/'platforms/android-36/android.jar').is_file(), 'Provision reviewed Android36 SDK and NDK28.2.13676358 inputs before building')
    release.require('Pkg.Revision = 28.2.13676358' in (ndk/'source.properties').read_text(), 'Unexpected Android NDK revision')
    release.require((ROOT/'android/gradle/wrapper/gradle-wrapper.jar').is_file(), 'Missing Gradle wrapper')
    release.require(release.sha256(ROOT/'android/gradle/wrapper/gradle-wrapper.jar') == 'b3a875ddc1f044746e1b1a55f645584505f4a10438c1afea9f15e92a7c42ec13', 'Gradle wrapper checksum mismatch')
    bindings(stage, cache, environment, 'kotlin')
    host = 'darwin-x86_64' if sys.platform == 'darwin' else 'linux-x86_64'
    tools = ndk/'toolchains/llvm/prebuilt'/host/'bin'
    environment.update(CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=str(tools/'aarch64-linux-android29-clang'), CC_aarch64_linux_android=str(tools/'aarch64-linux-android29-clang'), AR_aarch64_linux_android=str(tools/'llvm-ar'))
    rust(environment, 'build', '--locked', '--release', '-p', 'iris-market-app', '--target', 'aarch64-linux-android')
    jni = stage/'jniLibs/arm64-v8a'; jni.mkdir(parents=True)
    shutil.copyfile(cache/'aarch64-linux-android/release/libiris_market_app.so', jni/'libiris_market_app.so')
    environment.update(MARKET_ANDROID_BINDINGS_DIR=str(stage/'Bindings'), MARKET_ANDROID_JNI_DIR=str(stage/'jniLibs'), MARKET_RELEASE_VERSION=args.tag[1:], MARKET_ANDROID_VERSION_CODE=str(args.build_number), ANDROID_HOME=str(sdk))
    run([ROOT/'android/gradlew', '-p', ROOT/'android', '--offline', '--no-daemon', '--max-workers=2', '--dependency-verification', 'strict', ':app:assembleRelease'], environment)
    apk = ROOT/'android/app/build/outputs/apk/release/app-release.apk'
    release.require(apk.is_file(), 'Expected signed release APK')
    apksigner = sdk/'build-tools/36.0.0/apksigner'
    release.require(apksigner.is_file(), 'Reviewed Android build-tools36.0.0 are required for signature verification')
    run([apksigner, 'verify', apk], environment)
    shutil.copyfile(apk, args.output/release.asset_name(args.tag, args.platform))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform', choices=('ios-arm64','macos-arm64','android-arm64'), required=True)
    parser.add_argument('--tag', required=True); parser.add_argument('--commit', required=True); parser.add_argument('--build-number', type=int, required=True)
    parser.add_argument('--android-inputs', type=Path); parser.add_argument('--inputs', type=Path, required=True); parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(); inputs = release.preflight(args.tag, args.commit, args.platform, args.inputs, args.build_number)
    args.output = args.output.resolve(); args.output.mkdir(parents=True, exist_ok=True)
    release.require(not (args.output/release.asset_name(args.tag,args.platform)).exists(), 'Never overwrite an existing release artifact')
    stage = args.output/(args.platform+'-staging'); stage.mkdir(mode=0o700, exist_ok=False)
    environment = release.verified_environment(args.inputs, inputs)
    if args.platform in ('ios-arm64', 'macos-arm64'):
        generator = next((tool for tool in inputs.get('nativeTools', []) if tool.get('name') == 'xcodegen'), None)
        release.require(generator is not None, 'Apple release requires checksum-verified XcodeGen in its input receipt')
        environment['MARKET_XCODEGEN'] = generator['binary']
    cache = Path(environment.get('CARGO_TARGET_DIR', ROOT/'target')).resolve()
    environment['CARGO_TARGET_DIR'] = str(cache)
    {'ios-arm64':build_ios,'macos-arm64':build_macos,'android-arm64':build_android}[args.platform](args,stage,cache,environment)
    release.exact_source(args.tag,args.commit)
    artifact = args.output/release.asset_name(args.tag,args.platform)
    print(json.dumps({'platform':args.platform,'asset':artifact.name,'sourceCommit':args.commit,'sha256':release.sha256(artifact),'readyForPublication':False}))


if __name__ == '__main__':
    try: main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr); sys.exit(1)
