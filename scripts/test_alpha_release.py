#!/usr/bin/env python3
"""Source-only tests. All artifacts and acceptance evidence are synthetic."""
import copy
import importlib.util
import json
import io
import os
import plistlib
from pathlib import Path
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('alpha_release', Path(__file__).with_name('alpha-release.py'))
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)
def load(name, filename):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(filename))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module
installer=load('release_inputs_test','release-build-inputs.py')
signer=load('android_sign_test','android-sign.py')
native=load('native_alpha_test','native-alpha.py')
TAG, COMMIT, DIGEST = 'v0.1.0-alpha.1', 'a'*40, 'b'*64


class AlphaContract(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for platform in release.PLATFORMS:
            (self.root/release.asset_name(TAG, platform)).write_bytes(b'synthetic fixture '+platform.encode())
        self.entries = release.asset_entries(self.root, TAG)
        check = {'passed': True, 'sourceCommit': COMMIT, 'evidenceSHA256': DIGEST}
        self.gate = {'schema': 2, 'tag': TAG, 'sourceCommit': COMMIT, 'accepted': True,
                     'source': {channel: {'commit': COMMIT, 'coldFetch': True, 'completeHistory': True, 'evidenceSHA256': DIGEST} for channel in ('github', 'hashtree')},
                     'checks': {name: dict(check) for name in ('core', 'source-audit', *release.PLATFORMS)}}
        for entry in self.entries:
            self.gate['checks'][entry['platform']].update(artifactSHA256=entry['sha256'], signed=True, notarized=True, sourceClean=True, bundledAssetsVerified=True, installedOrExtractedBytesVerified=True, runtimeVersionsRecorded=True)
        self.manifest = {'schema': 2, 'product': 'iris-market', 'channel': 'alpha', 'tag': TAG, 'sourceCommit': COMMIT, 'artifacts': self.entries}

    def test_full_inventory_and_exact_acceptance(self):
        self.assertEqual(len(self.entries), 9)
        release.check_acceptance(self.gate, TAG, COMMIT, self.entries)
        release.verify(self.manifest, self.root, TAG, COMMIT)

    def test_schema_one_keeps_frozen_seven_artifact_releases_verifiable(self):
        entries = [entry for entry in self.entries if entry['platform'] in release.LEGACY_PLATFORMS]
        manifest = {**self.manifest, 'schema': 1, 'artifacts': entries}
        gate = {**self.gate, 'schema': 1}
        release.verify(manifest, self.root, TAG, COMMIT)
        release.check_acceptance(gate, TAG, COMMIT, entries)
        with self.assertRaises(ValueError): release.verify(manifest, self.root, TAG, COMMIT, 'linux-desktop-x64-deb')

    def test_linux_acceptance_covers_final_package_and_bundled_assets(self):
        for platform in release.LINUX_DESKTOP_PLATFORMS:
            for field in ('sourceClean', 'bundledAssetsVerified', 'installedOrExtractedBytesVerified', 'runtimeVersionsRecorded'):
                gate = copy.deepcopy(self.gate); gate['checks'][platform][field] = False
                with self.assertRaises(ValueError): release.check_acceptance(gate, TAG, COMMIT, self.entries)
        with self.assertRaises(ValueError): release.verify({**self.manifest, 'artifacts': self.entries[:-1]}, self.root, TAG, COMMIT)

    def test_publication_inventory_derives_all_eleven_files_and_rechecks_acceptance(self):
        acceptance = self.root/'acceptance.json'; acceptance.write_text(json.dumps(self.gate))
        manifest = {**self.manifest, 'acceptanceSHA256':release.sha256(acceptance)}
        (self.root/'release-manifest.json').write_text(json.dumps(manifest))
        sums = ''.join(entry['sha256']+'  '+entry['name']+'\n' for entry in self.entries)
        (self.root/'SHA256SUMS').write_text(sums)
        args = SimpleNamespace(tag=TAG, commit=COMMIT, assets=self.root, acceptance=acceptance)
        with patch.object(release, 'exact_source'):
            proof = release.publication_files(args)
            self.assertEqual(len(proof['files']), 11)
            self.assertEqual(proof['files'][-2]['name'], 'release-manifest.json')
            acceptance.write_text(json.dumps({**self.gate, 'accepted':False}))
            with self.assertRaises(ValueError): release.publication_files(args)
            acceptance.write_text(json.dumps(self.gate))
            (self.root/'SHA256SUMS').write_text(sums+'unexpected\n')
            with self.assertRaises(ValueError): release.publication_files(args)

    def test_external_apple_sources_do_not_walk_intermediate_groups(self):
        source = self.root/'source'
        (source/'ios').mkdir(parents=True)
        repository = Path(__file__).resolve().parents[1]
        for filename in ('project.yml', 'Info.plist', 'NotificationService/Info.plist'):
            (source/'ios'/filename).parent.mkdir(parents=True, exist_ok=True)
            (source/'ios'/filename).write_bytes((repository/'ios'/filename).read_bytes())
        stage = self.root/'generated'; stage.mkdir()
        (stage/'headers').mkdir()
        with patch.object(native, 'ROOT', source), patch.object(native, 'run') as run:
            native.apple_project(stage, 'ios-arm64', {'MARKET_XCODEGEN': '/verified/xcodegen', 'MARKET_IOS_PROFILE_UUID':'fixture-main', 'MARKET_IOS_NSE_PROFILE_UUID':'fixture-nse'})
        project = (stage/'project.yml').read_text()
        self.assertIn('createIntermediateGroups: false', project)
        self.assertIn('- path: '+str(source/'ios/Sources'), project)
        self.assertIn('- path: '+str(stage/'Bindings'), project)
        self.assertEqual(run.call_args.args[0][0], '/verified/xcodegen')

    def test_ios_stage_paths_and_profiles_are_target_scoped(self):
        source = self.root/'source'; (source/'ios').mkdir(parents=True)
        for filename in ('project.yml', 'Info.plist', 'NotificationService/Info.plist'):
            (source/'ios'/filename).parent.mkdir(parents=True, exist_ok=True)
            (source/'ios'/filename).write_bytes((Path(__file__).resolve().parents[1]/'ios'/filename).read_bytes())
        stage = self.root/'stage'; stage.mkdir(); (stage/'headers').mkdir()
        environment = {'MARKET_IOS_PUSH_ENABLED':'1', 'MARKET_IOS_PROFILE_UUID':'fixture-main', 'MARKET_IOS_NSE_PROFILE_UUID':'fixture-nse'}
        with patch.object(native,'ROOT',source), patch.object(native,'run'):
            native.apple_project(stage,'ios-arm64',environment)
        text = (stage/'project.yml').read_text()
        for relative in ('NotificationService','Market.entitlements','NotificationService/NotificationService.entitlements','Simulator.entitlements','Sources/NativePushShared.swift'):
            self.assertIn(str(source/'ios'/relative),text)
        info = plistlib.loads((stage/'Info.plist').read_bytes())
        self.assertEqual(info['MarketPushConfigured'], 'YES')
        self.assertEqual(info['UIBackgroundModes'], ['remote-notification'])
        nse_info = plistlib.loads((stage/'NotificationService-Info.plist').read_bytes())
        self.assertEqual(nse_info['MarketPushConfigured'], 'YES')
        self.assertEqual(nse_info['MarketNotificationFilteringConfigured'], 'NO')
        self.assertIn(str(stage/'NotificationService-Info.plist'), text)
        self.assertIn('MarketNotificationKeychainGroup', info)
        header, targets = text.split('\ntargets:\n',1)
        self.assertNotIn('PROVISIONING_PROFILE_SPECIFIER',header)
        main = targets.split('  IrisMarket:',1)[1].split('  IrisMarketUITests:',1)[0]
        nse = text.split('  MarketNotificationService:',1)[1]
        self.assertIn('PROVISIONING_PROFILE_SPECIFIER: "fixture-main"',main)
        self.assertNotIn('"fixture-nse"',main)
        self.assertIn('PROVISIONING_PROFILE_SPECIFIER: "fixture-nse"',nse)
        self.assertNotIn('"fixture-main"',nse)
        self.assertEqual((stage/'project.yml').stat().st_mode & 0o777,0o600)

    def test_ios_requires_extension_profile_and_exact_target(self):
        self.assertNotIn('MARKET_IOS_NSE_PROFILE_UUID',release.REQUIRED_ENV['ios-arm64'])
        source = self.root/'source'; (source/'ios').mkdir(parents=True)
        for filename in ('project.yml', 'Info.plist', 'NotificationService/Info.plist'):
            (source/'ios'/filename).parent.mkdir(parents=True, exist_ok=True)
            (source/'ios'/filename).write_bytes((Path(__file__).resolve().parents[1]/'ios'/filename).read_bytes())
        stage = self.root/'stage'; stage.mkdir(); (stage/'headers').mkdir()
        with patch.object(native,'ROOT',source), patch.object(native,'run') as run:
            with self.assertRaisesRegex(ValueError,'MARKET_IOS_NSE_PROFILE_UUID'):
                native.apple_project(stage,'ios-arm64',{'MARKET_IOS_PUSH_ENABLED':'1','MARKET_IOS_PROFILE_UUID':'fixture-main'})
            (stage/'Info.plist').unlink()
            (stage/'NotificationService-Info.plist').unlink()
            (source/'ios/project.yml').write_text('PRODUCT_BUNDLE_IDENTIFIER: to.iris.market\n      - sdk: libsqlite3.tbd\n')
            with self.assertRaisesRegex(ValueError,'Expected exactly one iOS signing target'):
                native.apple_project(stage,'ios-arm64',{'MARKET_IOS_PUSH_ENABLED':'1','MARKET_IOS_PROFILE_UUID':'fixture-main','MARKET_IOS_NSE_PROFILE_UUID':'fixture-nse'})
            run.assert_not_called()

    def test_ios_archive_uses_target_profiles_and_exports_both_bundles(self):
        source=self.root/'source'; icon=source/'ios/Assets.xcassets/AppIcon.appiconset/Contents.json'; icon.parent.mkdir(parents=True);icon.write_text('{}')
        sdk=self.root/'sdk';(sdk/'usr/lib').mkdir(parents=True);(sdk/'usr/lib/libsqlite3.tbd').write_text('fixture')
        stage=self.root/'stage';stage.mkdir();(stage/'export').mkdir();(stage/'export/fixture.ipa').write_bytes(b'fixture')
        output=self.root/'output';output.mkdir()
        args=SimpleNamespace(tag=TAG,build_number=12,platform='ios-arm64',output=output)
        environment={'MARKET_IOS_PUSH_ENABLED':'1','MARKET_APPLE_TEAM_ID':'fixture-team','MARKET_IOS_SIGNING_IDENTITY':'fixture-identity','MARKET_IOS_PROFILE_UUID':'fixture-main','MARKET_IOS_NSE_PROFILE_UUID':'fixture-nse'}
        with patch.object(native,'ROOT',source),patch.object(native.sys,'platform','darwin'),patch.object(native,'ios_signing_preflight'),patch.object(native,'bindings'),patch.object(native,'rust'),patch.object(native,'apple_headers'),patch.object(native,'apple_project'),patch.object(native.subprocess,'check_output',return_value=str(sdk)),patch.object(native,'run') as run:
            native.build_ios(args,stage,self.root/'cache',environment)
        archive=next(call.args[0] for call in run.call_args_list if 'archive' in call.args[0])
        self.assertIn('MARKET_PUSH_CONFIGURED=YES', archive)
        self.assertFalse(any(str(value).startswith('PROVISIONING_PROFILE_SPECIFIER=') for value in archive))
        options=plistlib.loads((stage/'ExportOptions.plist').read_bytes())
        self.assertEqual(options['provisioningProfiles'],{'to.iris.market':'fixture-main','to.iris.market.NotificationService':'fixture-nse'})
        self.assertTrue(options['testFlightInternalTestingOnly'])
        self.assertEqual(environment['MARKET_APS_ENVIRONMENT'],'production')

    def test_ios_push_profiles_fail_closed_before_compilation(self):
        with patch.object(native.sys, 'platform', 'darwin'), patch.object(native, 'bindings') as bindings, patch.object(native, 'ios_signing_preflight', side_effect=ValueError('profile capability missing')):
            with self.assertRaisesRegex(ValueError, 'profile capability missing'):
                native.build_ios(SimpleNamespace(), self.root, self.root, {})
            bindings.assert_not_called()

    def test_ios_nonpush_project_excludes_extension_and_push_capabilities(self):
        source = self.root/'source'; (source/'ios').mkdir(parents=True)
        repository = Path(__file__).resolve().parents[1]
        for filename in ('project.yml', 'Info.plist', 'NotificationService/Info.plist'):
            (source/'ios'/filename).parent.mkdir(parents=True, exist_ok=True)
            (source/'ios'/filename).write_bytes((repository/'ios'/filename).read_bytes())
        stage = self.root/'stage'; stage.mkdir(); (stage/'headers').mkdir()
        with patch.object(native,'ROOT',source), patch.object(native,'run'):
            native.apple_project(stage,'ios-arm64',{'MARKET_IOS_PUSH_ENABLED':'0','MARKET_IOS_PROFILE_UUID':'fixture-main'})
        text = (stage/'project.yml').read_text()
        self.assertNotIn('MarketNotificationService', text)
        self.assertIn('CODE_SIGN_ENTITLEMENTS: '+str(source/'ios/NonPush.entitlements'), text)
        self.assertIn('PROVISIONING_PROFILE_SPECIFIER: "fixture-main"', text)
        info = plistlib.loads((stage/'Info.plist').read_bytes())
        self.assertEqual(info['MarketPushConfigured'], 'NO')
        self.assertNotIn('UIBackgroundModes', info)
        self.assertNotIn('MarketNotificationKeychainGroup', info)
        entitlements = plistlib.loads((repository/'ios/NonPush.entitlements').read_bytes())
        self.assertEqual(entitlements, {'keychain-access-groups':['$(AppIdentifierPrefix)$(CFBundleIdentifier)']})

    def test_ios_nonpush_archive_exports_only_main_profile(self):
        source=self.root/'source'; icon=source/'ios/Assets.xcassets/AppIcon.appiconset/Contents.json'; icon.parent.mkdir(parents=True); icon.write_text('{}')
        sdk=self.root/'sdk'; (sdk/'usr/lib').mkdir(parents=True); (sdk/'usr/lib/libsqlite3.tbd').write_text('fixture')
        stage=self.root/'stage'; stage.mkdir(); (stage/'export').mkdir(); (stage/'export/fixture.ipa').write_bytes(b'fixture')
        output=self.root/'output'; output.mkdir()
        args=SimpleNamespace(tag=TAG,build_number=13,platform='ios-arm64',output=output)
        environment={'MARKET_IOS_PUSH_ENABLED':'0','MARKET_APPLE_TEAM_ID':'fixture-team','MARKET_IOS_SIGNING_IDENTITY':'fixture-identity','MARKET_IOS_PROFILE_UUID':'fixture-main'}
        with patch.object(native,'ROOT',source), patch.object(native.sys,'platform','darwin'), patch.object(native,'ios_signing_preflight') as signing, patch.object(native,'bindings'), patch.object(native,'rust'), patch.object(native,'apple_headers'), patch.object(native,'apple_project'), patch.object(native.subprocess,'check_output',return_value=str(sdk)), patch.object(native,'run') as run:
            native.build_ios(args,stage,self.root/'cache',environment)
        signing.assert_called_once_with(environment)
        archive=next(call.args[0] for call in run.call_args_list if 'archive' in call.args[0])
        self.assertIn('MARKET_PUSH_CONFIGURED=NO', archive)
        options=plistlib.loads((stage/'ExportOptions.plist').read_bytes())
        self.assertEqual(options['provisioningProfiles'], {'to.iris.market':'fixture-main'})
        self.assertTrue(options['testFlightInternalTestingOnly'])

    def test_ios_mode_is_explicit_and_invalid_values_fail_closed(self):
        self.assertFalse(release.ios_push_enabled({}))
        self.assertFalse(release.ios_push_enabled({'MARKET_IOS_PUSH_ENABLED':'0'}))
        self.assertTrue(release.ios_push_enabled({'MARKET_IOS_PUSH_ENABLED':'1'}))
        for value in ('', 'YES', 'false', '2'):
            with self.assertRaisesRegex(ValueError, '0 or 1'):
                release.ios_push_enabled({'MARKET_IOS_PUSH_ENABLED':value})

    def test_ios_filtering_is_independent_explicit_and_requires_push(self):
        self.assertFalse(release.ios_notification_filtering_enabled({}))
        self.assertFalse(release.ios_notification_filtering_enabled({'MARKET_IOS_PUSH_ENABLED':'1'}))
        self.assertTrue(release.ios_notification_filtering_enabled({'MARKET_IOS_PUSH_ENABLED':'1','MARKET_IOS_NOTIFICATION_FILTERING_ENABLED':'1'}))
        with self.assertRaisesRegex(ValueError, 'requires iOS push'):
            release.ios_notification_filtering_enabled({'MARKET_IOS_PUSH_ENABLED':'0','MARKET_IOS_NOTIFICATION_FILTERING_ENABLED':'1'})
        for value in ('', 'YES', 'false', '2'):
            with self.assertRaisesRegex(ValueError, '0 or 1'):
                release.ios_notification_filtering_enabled({'MARKET_IOS_PUSH_ENABLED':'1','MARKET_IOS_NOTIFICATION_FILTERING_ENABLED':value})

    def test_ios_filtering_project_requests_separate_entitlement_and_runtime_flag(self):
        source = self.root/'source'; (source/'ios').mkdir(parents=True)
        repository = Path(__file__).resolve().parents[1]
        for filename in ('project.yml', 'Info.plist', 'NotificationService/Info.plist'):
            (source/'ios'/filename).parent.mkdir(parents=True, exist_ok=True)
            (source/'ios'/filename).write_bytes((repository/'ios'/filename).read_bytes())
        stage = self.root/'stage'; stage.mkdir(); (stage/'headers').mkdir()
        environment={'MARKET_IOS_PUSH_ENABLED':'1','MARKET_IOS_NOTIFICATION_FILTERING_ENABLED':'1','MARKET_IOS_PROFILE_UUID':'fixture-main','MARKET_IOS_NSE_PROFILE_UUID':'fixture-nse'}
        with patch.object(native,'ROOT',source), patch.object(native,'run'):
            native.apple_project(stage,'ios-arm64',environment)
        text = (stage/'project.yml').read_text()
        self.assertIn('CODE_SIGN_ENTITLEMENTS: '+str(source/'ios/NotificationService/Filtering.entitlements'),text)
        info = plistlib.loads((stage/'NotificationService-Info.plist').read_bytes())
        self.assertEqual(info['MarketNotificationFilteringConfigured'],'YES')
        standard=plistlib.loads((repository/'ios/NotificationService/NotificationService.entitlements').read_bytes())
        filtering=plistlib.loads((repository/'ios/NotificationService/Filtering.entitlements').read_bytes())
        self.assertNotIn('com.apple.developer.usernotifications.filtering',standard)
        self.assertEqual(filtering,{**standard,'com.apple.developer.usernotifications.filtering':True})

    def test_ios_nonpush_signing_still_requires_exact_distribution_and_keychain(self):
        import datetime
        home=self.root/'home'; directory=home/'Library/MobileDevice/Provisioning Profiles'; directory.mkdir(parents=True)
        (directory/'main.mobileprovision').write_bytes(b'fixture')
        environment={'MARKET_IOS_PUSH_ENABLED':'0','MARKET_APPLE_TEAM_ID':'TESTTEAM','MARKET_IOS_PROFILE_UUID':'main'}
        entitlements={'application-identifier':'TESTTEAM.to.iris.market','com.apple.developer.team-identifier':'TESTTEAM','get-task-allow':False,'keychain-access-groups':['TESTTEAM.*']}
        profile={'UUID':'main','TeamIdentifier':['TESTTEAM'],'ExpirationDate':datetime.datetime.now()+datetime.timedelta(days=1),'Entitlements':entitlements}
        def decode(*args, **kwargs): return plistlib.dumps(profile)
        with patch.object(native.Path,'home',return_value=home), patch.object(native.subprocess,'check_output',side_effect=decode):
            native.ios_signing_preflight(environment)
            for changed, message in (({'ExpirationDate':datetime.datetime.now()-datetime.timedelta(days=1)},'Expired'), ({'TeamIdentifier':['OTHERTEAM']},'team mismatch'), ({'ProvisionedDevices':['fixture']},'App Store'), ({'ProvisionsAllDevices':True},'App Store')):
                with patch.dict(profile, changed):
                    with self.assertRaisesRegex(ValueError,message): native.ios_signing_preflight(environment)
            for changed, message in (({'application-identifier':'TESTTEAM.other.app'},'App Store'), ({'get-task-allow':True},'App Store'), ({'keychain-access-groups':['TESTTEAM.other.app']},'keychain-access-groups')):
                with patch.dict(entitlements, changed):
                    with self.assertRaisesRegex(ValueError,message): native.ios_signing_preflight(environment)
            with self.assertRaisesRegex(ValueError,'matching distribution profile'):
                native.ios_signing_preflight({**environment,'MARKET_IOS_PROFILE_UUID':'absent'})

    def test_ios_push_profile_entitlements_and_distribution(self):
        import datetime
        repository = Path(__file__).resolve().parents[1]
        home = self.root/'home'; directory = home/'Library/MobileDevice/Provisioning Profiles'; directory.mkdir(parents=True)
        environment = {'MARKET_IOS_PUSH_ENABLED':'1', 'MARKET_IOS_NOTIFICATION_FILTERING_ENABLED':'1', 'MARKET_APPLE_TEAM_ID':'TESTTEAM', 'MARKET_IOS_PROFILE_UUID':'main', 'MARKET_IOS_NSE_PROFILE_UUID':'nse'}
        profiles = {}
        for name, bundle, filename in (('main','to.iris.market','Market.entitlements'), ('nse','to.iris.market.NotificationService','NotificationService/Filtering.entitlements')):
            entitlements = plistlib.loads((repository/'ios'/filename).read_bytes())
            for key, value in entitlements.items():
                def expand(item):
                    return item.replace('$(APS_ENVIRONMENT)','production').replace('$(AppIdentifierPrefix)','TESTTEAM.').replace('$(CFBundleIdentifier)',bundle) if isinstance(item,str) else item
                entitlements[key] = [expand(item) for item in value] if isinstance(value,list) else expand(value)
            entitlements.update({'application-identifier':'TESTTEAM.'+bundle, 'com.apple.developer.team-identifier':'TESTTEAM', 'get-task-allow':False})
            profiles[name] = {'UUID':name, 'TeamIdentifier':['TESTTEAM'], 'ExpirationDate':datetime.datetime.now()+datetime.timedelta(days=1), 'Entitlements':entitlements}
            (directory/(name+'.mobileprovision')).write_bytes(b'fixture')
        def decode(command, **kwargs): return plistlib.dumps(profiles[Path(command[-1]).stem])
        with patch.object(native.Path,'home',return_value=home), patch.object(native.subprocess,'check_output',side_effect=decode):
            native.ios_signing_preflight(environment)
            profiles['nse']['Entitlements'].pop('com.apple.developer.usernotifications.filtering')
            with self.assertRaisesRegex(ValueError,'usernotifications.filtering'): native.ios_signing_preflight(environment)
            native.ios_signing_preflight({**environment,'MARKET_IOS_NOTIFICATION_FILTERING_ENABLED':'0'})
            profiles['nse']['Entitlements']['com.apple.developer.usernotifications.filtering'] = True
            profiles['main']['Entitlements']['aps-environment'] = 'development'
            with self.assertRaisesRegex(ValueError,'aps-environment'): native.ios_signing_preflight(environment)
            profiles['main']['Entitlements']['aps-environment'] = 'production'
            profiles['main']['ProvisionedDevices'] = ['fixture']
            with self.assertRaisesRegex(ValueError,'App Store'): native.ios_signing_preflight(environment)

    def test_release_path_remaps_preserve_flags_and_paths_with_spaces(self):
        home = self.root/'private user'
        source = home/'accepted source'
        with patch.object(native.Path, 'home', return_value=home), patch.object(native, 'ROOT', source):
            result = native.release_environment({'RUSTFLAGS':'-C opt-level=3', 'CARGO_HOME':str(home/'cargo')})
        flags = result['CARGO_ENCODED_RUSTFLAGS'].split('\x1f')
        self.assertEqual(flags[:2], ['-C','opt-level=3'])
        self.assertEqual(flags[-1], '--remap-path-prefix='+str(source.resolve())+'=/source/iris-market')
        self.assertIn('--remap-path-prefix='+str(home.resolve())+'=/build/home',flags)
        self.assertNotIn('RUSTFLAGS',result)

    def test_native_release_disables_inherited_compiler_wrappers(self):
        inherited={'RUSTC_WRAPPER':'/host/cache-wrapper','RUSTC_WORKSPACE_WRAPPER':'/host/workspace-wrapper'}
        result=native.release_environment(inherited)
        self.assertEqual(result['RUSTC_WRAPPER'],'')
        self.assertEqual(result['RUSTC_WORKSPACE_WRAPPER'],'')
        self.assertEqual(inherited['RUSTC_WRAPPER'],'/host/cache-wrapper')
        # Explicit empties also override wrappers from user Cargo config when
        # neither variable was set in the process environment.
        defaults=native.release_environment({})
        self.assertEqual(defaults['RUSTC_WRAPPER'],'')
        self.assertEqual(defaults['RUSTC_WORKSPACE_WRAPPER'],'')

    def test_macos_packages_signed_archive_product_not_build_product(self):
        stage=self.root/'stage'; cache=self.root/'cache'
        args=SimpleNamespace(platform='macos-arm64',tag=TAG,build_number=1,output=self.root)
        environment={'MARKET_MACOS_SIGNING_IDENTITY':'synthetic identity','MARKET_APPLE_TEAM_ID':'synthetic team'}
        with patch.object(native.sys,'platform','darwin'), patch.object(native,'bindings'), patch.object(native,'rust'), patch.object(native,'apple_project'), patch.object(native,'run') as run:
            native.build_macos(args,stage,cache,environment)
        commands=[call.args[0] for call in run.call_args_list]
        archive=stage/'IrisMarket.xcarchive'
        app=archive/'Products/Applications/IrisMarket.app'
        self.assertEqual(commands[0][-1],'archive')
        self.assertEqual(commands[0][commands[0].index('-archivePath')+1],archive)
        self.assertEqual(commands[1],['codesign','--verify','--deep','--strict',app])
        self.assertEqual(commands[2][-2],app)

    def test_native_reuse_verifies_every_payload_byte_and_executable_mode(self):
        destination=self.root/'native';destination.mkdir()
        binary=destination/'tool';binary.write_bytes(b'verified');binary.chmod(0o755)
        resource=destination/'resource';resource.write_bytes(b'data');resource.chmod(0o644)
        archive=self.root/'native.zip'
        with zipfile.ZipFile(archive,'w') as output:
            for name, data, mode in [('tool',b'verified',0o100755),('resource',b'data',0o100644)]:
                entry=zipfile.ZipInfo(name);entry.external_attr=mode<<16;output.writestr(entry,data)
        pin={'format':'zip','size':archive.stat().st_size,'sha256':release.sha256(archive)}
        installer.verify_native_install(archive,pin,destination)
        resource.write_bytes(b'bad!')
        with self.assertRaises(ValueError):installer.verify_native_install(archive,pin,destination)
        resource.write_bytes(b'data');binary.chmod(0o644)
        with self.assertRaises(ValueError):installer.verify_native_install(archive,pin,destination)

    def test_native_reuse_checks_tar_symlink_targets(self):
        destination=self.root/'native';destination.mkdir()
        binary=destination/'tool';binary.write_bytes(b'verified');binary.chmod(0o755)
        (destination/'link').symlink_to('tool')
        archive=self.root/'native.tar.gz'
        with tarfile.open(archive,'w:gz') as output:
            entry=tarfile.TarInfo('tool');entry.mode=0o755;entry.size=8;output.addfile(entry,io.BytesIO(b'verified'))
            entry=tarfile.TarInfo('link');entry.type=tarfile.SYMTYPE;entry.linkname='tool';output.addfile(entry)
        pin={'format':'tar.gz','size':archive.stat().st_size,'sha256':release.sha256(archive)}
        installer.verify_native_install(archive,pin,destination)
        (destination/'link').unlink();(destination/'link').symlink_to('../outside')
        with self.assertRaises(ValueError):installer.verify_native_install(archive,pin,destination)

    def test_native_archive_rejects_embedded_private_paths_across_chunks(self):
        good=self.root/'good.ipa';bad=self.root/'bad.ipa'
        with zipfile.ZipFile(good,'w') as archive:archive.writestr('Payload/Market',b'/source/iris-market/src/lib.rs')
        native.verify_release_paths(good,{})
        with zipfile.ZipFile(bad,'w') as archive:
            archive.writestr('Payload/Market',b'x'*(1024*1024-3)+str(Path.home()).encode()+b'/private.rs')
        with self.assertRaises(ValueError):native.verify_release_paths(bad,{})

    def test_rejects_ambiguous_identity(self):
        for tag in ('latest', 'v0.1.0', 'v0.1.0-alpha.0', '../alpha.1'):
            with self.assertRaises(ValueError): release.identity(tag, COMMIT)
        with self.assertRaises(ValueError): release.identity(TAG, COMMIT[:8])

    def test_stale_source_or_missing_cold_history_fails(self):
        for channel in ('github', 'hashtree'):
            gate = copy.deepcopy(self.gate); gate['source'][channel]['completeHistory'] = False
            with self.assertRaises(ValueError): release.check_acceptance(gate, TAG, COMMIT, self.entries)
        self.gate['checks']['cli-linux-x64']['sourceCommit'] = 'c'*40
        with self.assertRaises(ValueError): release.check_acceptance(self.gate, TAG, COMMIT, self.entries)

    def test_runtime_acceptance_is_for_exact_artifact_bytes(self):
        self.gate['checks']['ios-arm64']['artifactSHA256'] = DIGEST
        with self.assertRaises(ValueError): release.check_acceptance(self.gate, TAG, COMMIT, self.entries)

    def test_native_signing_and_notarization_are_required(self):
        for platform, field in (('ios-arm64', 'signed'), ('android-arm64', 'signed'), ('macos-arm64', 'signed'), ('macos-arm64', 'notarized')):
            gate = copy.deepcopy(self.gate); gate['checks'][platform][field] = False
            with self.assertRaises(ValueError): release.check_acceptance(gate, TAG, COMMIT, self.entries)

    def test_missing_duplicate_and_traversing_assets_fail(self):
        for entries in (self.entries[:-1], [self.entries[0]]*len(self.entries)):
            manifest = {**self.manifest, 'artifacts': entries}
            with self.assertRaises(ValueError): release.verify(manifest, self.root, TAG, COMMIT)
        self.entries[0]['name'] = '../secret'
        with self.assertRaises(ValueError): release.verify(self.manifest, self.root, TAG, COMMIT)

    def test_mutated_and_symlink_artifacts_fail(self):
        artifact = self.root/self.entries[0]['name']; artifact.write_bytes(b'changed')
        with self.assertRaises(ValueError): release.verify(self.manifest, self.root, TAG, COMMIT)
        artifact.unlink(); artifact.symlink_to(self.root/self.entries[1]['name'])
        with self.assertRaises(ValueError): release.asset_entries(self.root, TAG)

    def test_selected_platform_still_requires_canonical_full_inventory(self):
        release.verify(self.manifest, self.root, TAG, COMMIT, 'ios-arm64')
        with self.assertRaises(ValueError): release.verify(self.manifest, self.root, TAG, COMMIT, 'unknown')
        self.entries[-1]['target'] = 'unknown'
        with self.assertRaises(ValueError): release.verify(self.manifest, self.root, TAG, COMMIT, 'ios-arm64')

    def test_cli_packages_are_repeatable_and_keep_executable_mode(self):
        binary = self.root/'fixture-cli'; binary.write_bytes(b'synthetic executable')
        for platform, suffix in (('cli-linux-x64', '.tar.gz'), ('cli-windows-x64', '.zip')):
            outputs = [self.root/(str(index)+suffix) for index in (1, 2)]
            for output in outputs: release.package_cli(binary, output, TAG, platform, 1_700_000_000)
            self.assertEqual(release.sha256(outputs[0]), release.sha256(outputs[1]))
            if suffix == '.zip':
                with zipfile.ZipFile(outputs[0]) as archive:
                    self.assertEqual(archive.namelist(), ['iris-market/iris-market.exe', 'iris-market/LICENSE'])
                    self.assertEqual(archive.infolist()[0].external_attr >> 16 & 0o777, 0o755)
            else:
                with tarfile.open(outputs[0]) as archive:
                    self.assertEqual(archive.getnames(), ['iris-market/iris-market', 'iris-market/LICENSE'])
                    self.assertEqual(archive.getmembers()[0].mode, 0o755)
            with self.assertRaises(ValueError): release.package_cli(binary, outputs[0], TAG, platform, 0)

    def test_build_tool_paths_are_bound_to_receipt_install(self):
        receipt = self.root/'receipt.json'
        prefix = self.root/'toolchain/bin'; prefix.mkdir(parents=True)
        for name in ('cargo', 'rustc', 'rustdoc'): (prefix/name).write_text('fixture')
        env = release.verified_environment(receipt, {'host': 'aarch64-apple-darwin'}, {'PATH': '/fixture'})
        self.assertEqual(env['CARGO'], str((prefix/'cargo').resolve()))
        with self.assertRaises(ValueError): release.verified_environment(receipt, {'host': 'aarch64-apple-darwin'}, {'CARGO': '/unverified/cargo'})

    def test_existing_checksum_file_cannot_leave_partial_manifest(self):
        from types import SimpleNamespace
        acceptance = self.root/'acceptance.json'; acceptance.write_text(json.dumps(self.gate))
        manifest = self.root/'manifest.json'; (self.root/'SHA256SUMS').write_text('existing')
        args = SimpleNamespace(tag=TAG, commit=COMMIT, assets=self.root, acceptance=acceptance, manifest=manifest)
        with patch.object(release, 'exact_source'), patch.object(release, 'git', return_value='c'*40):
            with self.assertRaises(ValueError): release.seal(args)
        self.assertFalse(manifest.exists())

    def test_local_install_is_explicit_and_macos_only(self):
        with patch.dict(os.environ,{},clear=True),patch.object(installer.platform,'system',return_value='Darwin'):
            with self.assertRaises(ValueError):installer.installation_context()
            self.assertEqual(installer.installation_context(True),'local-macos')
        with patch.dict(os.environ,{},clear=True),patch.object(installer.platform,'system',return_value='Linux'):
            with self.assertRaises(ValueError):installer.installation_context(True)
        with patch.dict(os.environ,{'GITHUB_ACTIONS':'true','GITHUB_ENV':'/env','GITHUB_PATH':'/path'},clear=True):
            self.assertEqual(installer.installation_context(),'github-actions')
            with self.assertRaises(ValueError):installer.installation_context(True)

    def test_native_tool_mutation_is_rejected(self):
        prefix=self.root/'toolchain/bin';prefix.mkdir(parents=True)
        for name in ('cargo','rustc','rustdoc'):(prefix/name).write_text('fixture')
        tool=self.root/'native-cmake/bin/cmake';tool.parent.mkdir(parents=True);tool.write_text('verified fixture')
        receipt={'host':'aarch64-apple-darwin','nativeTools':[{'name':'cmake-ios','binary':str(tool),'binarySHA256':release.sha256(tool)}]}
        environment=release.verified_environment(self.root/'receipt.json',receipt,{'PATH':'/fixture'})
        self.assertEqual(environment['CMAKE'],str(tool.resolve()))
        tool.write_text('changed')
        with self.assertRaises(ValueError):release.verified_environment(self.root/'receipt.json',receipt,{'PATH':'/fixture'})

    def test_android_payload_proof_checks_bytes_metadata_and_names(self):
        def apk(name,content=b'native code',mode=0o100755,signature=False):
            path=self.root/name
            with zipfile.ZipFile(path,'w') as archive:
                archive.writestr('AndroidManifest.xml',b'fixture manifest')
                info=zipfile.ZipInfo('lib/arm64-v8a/libiris_market_app.so');info.external_attr=mode<<16
                archive.writestr(info,content)
                if signature:archive.writestr('META-INF/CERT.RSA',b'fixture signature')
            return path
        unsigned=apk('unsigned.apk');signed=apk('signed.apk',signature=True)
        self.assertEqual(signer.payload(unsigned),signer.payload(signed,True))
        with self.assertRaises(ValueError):signer.payload(signed)
        self.assertNotEqual(signer.payload(unsigned),signer.payload(apk('changed.apk',b'changed'),True))
        self.assertNotEqual(signer.payload(unsigned),signer.payload(apk('mode.apk',mode=0o100644),True))
        with zipfile.ZipFile(signed,'a') as archive:archive.writestr('../escaped',b'bad')
        with self.assertRaises(ValueError):signer.payload(signed,True)

    def test_unsigned_handoff_cannot_masquerade_as_release(self):
        path=self.root/(release.asset_name(TAG,'android-arm64').removesuffix('.apk')+'.unsigned.apk')
        path.write_bytes(b'fixture')
        receipt={'asset':path.name,'tag':TAG,'sourceCommit':COMMIT,'platform':'android-arm64','signed':False,'readyForPublication':False,'sha256':release.sha256(path)}
        signer.verify_handoff(receipt,path,TAG,COMMIT)
        for changed in ({'signed':True},{'sourceCommit':'c'*40},{'readyForPublication':True},{'sha256':DIGEST}):
            with self.assertRaises(ValueError):signer.verify_handoff(receipt|changed,path,TAG,COMMIT)


if __name__ == '__main__': unittest.main()
