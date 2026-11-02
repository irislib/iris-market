import http.client
import io
import json
import importlib.util
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location('iris_market', Path(__file__).resolve().parents[1] / 'iris_market.py')
APP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(APP)


class UpdatesTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / 'build-manifest.json').write_text(json.dumps({'version': '0.1.4-alpha.5'}))
        self.client = APP.UpdateClient(self.root, self.root / 'state', self.root / 'downloads')

    def tearDown(self):
        self.client.close()
        self.temporary.cleanup()

    def test_preferences_survive_restart_and_disabled_checks_stay_off(self):
        self.assertTrue(self.client.due(now=100000))
        self.client.preferences.update(automatic=False, lastAttempt=100000)
        self.client.save()
        restored = APP.UpdateClient(self.root, self.root / 'state', self.root / 'downloads')
        self.assertFalse(restored.due(now=200000))
        restored.preferences['automatic'] = True
        self.assertFalse(restored.due(now=100001))
        self.assertTrue(restored.due(now=200000))

    def test_check_and_download_use_the_same_rust_session(self):
        process = Mock()
        process.stdin = io.StringIO()
        result = {'available': True, 'verified': True, 'latest_version': '0.1.4-alpha.6'}
        process.stdout = io.StringIO(json.dumps({'ok': True, 'result': result}) + '\n' + json.dumps({'ok': True, 'result': result}) + '\n')
        with patch.object(APP.subprocess, 'Popen', return_value=process) as launch:
            self.client.request('check')
            self.client.request('download')
            self.assertEqual(launch.call_count, 1)
        self.assertEqual(process.stdin.getvalue(), 'check\ndownload\n')

    def test_refuses_unchecked_downloads_and_unverified_results(self):
        with self.assertRaises(ValueError): self.client.request('download')
        process = Mock(stdin=io.StringIO(), stdout=io.StringIO('{"ok":true,"result":{"verified":false}}\n'))
        with patch.object(APP.subprocess, 'Popen', return_value=process), self.assertRaises(ValueError):
            self.client.request('check')
        self.assertIsNone(self.client.result)
        process.terminate.assert_called_once()

    def test_handoff_cannot_open_arbitrary_files(self):
        self.client.result = {'path': str(self.root / 'build-manifest.json')}
        with self.assertRaises(ValueError): self.client.download_uri()
        self.client.downloads.mkdir()
        artifact = self.client.downloads / 'update.deb'
        artifact.write_bytes(b'package')
        self.client.result = {'path': str(artifact)}
        self.assertEqual(self.client.download_uri(), artifact.resolve().as_uri())


class DesktopTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'web'
        self.root.mkdir()
        (self.root / 'index.html').write_text('market')
        (self.root / 'app.js').write_text('let x = 1;')
        (self.root / '_headers').write_text("/*\n  Content-Security-Policy: default-src 'self'; object-src 'none'\n  X-Content-Type-Options: nosniff\n")
        (Path(self.temp.name) / 'secret').write_text('secret')
        (self.root / 'link').symlink_to(Path(self.temp.name) / 'secret')
        import functools
        from http.server import ThreadingHTTPServer
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(APP.AssetHandler, directory=self.root))
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()
        self.temp.cleanup()

    def get(self, path, host=None, method='GET'):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        connection.request(method, path, headers={'Host': host or APP.ORIGIN.removeprefix('http://')})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_routes_and_assets(self):
        for path in ('/', '/post', '/settings/profile', '/messages/abc', '/saved', '/invite?code=abc'):
            self.assertEqual(self.get(path)[2], b'market', path)
        self.assertEqual(self.get('/app.js')[0], 200)
        self.assertEqual(self.get('/missing.js')[0], 404)
        self.assertEqual(self.get('/_headers')[0], 404)

    def test_traversal_and_symlinks(self):
        for path in ('/../secret', '/%2e%2e/secret', '/%2e%2e%2fsecret', '/link'):
            self.assertEqual(self.get(path)[0], 403, path)

    def test_host_validation(self):
        for host in ('attacker.example', 'localhost:45876', '127.0.0.1:45876.attacker.example'):
            self.assertEqual(self.get('/', host)[0], 403)

    def test_csp_and_head(self):
        status, headers, data = self.get('/app.js')
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Security-Policy'], "default-src 'self'; object-src 'none'")
        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(self.get('/app.js', method='HEAD')[2], b'')
        self.assertIn(b'unregister', self.get('/sw.js')[2])

    def test_engine_defaults_are_scoped_and_preserve_overrides(self):
        environment = {}
        APP.configure_webkit_environment(environment)
        self.assertEqual(environment, {'JSC_useOMGJIT': 'false', 'JSC_numberOfWasmCompilerThreads': '1'})
        override = {'JSC_useOMGJIT': 'true', 'JSC_numberOfWasmCompilerThreads': '2'}
        APP.configure_webkit_environment(override)
        self.assertEqual(override, {'JSC_useOMGJIT': 'true', 'JSC_numberOfWasmCompilerThreads': '2'})

    def test_browser_languages(self):
        self.assertEqual(APP.browser_languages(['C.UTF-8', 'C', 'POSIX']), ['en-US'])
        self.assertEqual(APP.browser_languages(['fi_FI.UTF-8', 'fi_FI', 'en_US@variant', 'C']), ['fi-FI', 'en-US'])

    def test_external_invoice_handoff_is_narrow(self):
        self.assertTrue(APP.external_uri_allowed('lightning:lnbc10n1' + 'q' * 110))
        self.assertTrue(APP.external_uri_allowed('https://example.com'))
        for uri in ('file:///tmp/private', 'javascript:alert(1)', 'cashu:secret',
                    'lightning:https://example.com', 'lightning:lnbc1q?x=1', APP.ORIGIN):
            self.assertFalse(APP.external_uri_allowed(uri), uri)

    def test_persistent_profile_paths(self):
        self.assertEqual(APP.profile_paths({'HOME':'/test'}), (Path('/test/.local/share/iris-market'), Path('/test/.cache/iris-market')))
        self.assertEqual(APP.profile_paths({'HOME':'/test','XDG_DATA_HOME':'/data','XDG_CACHE_HOME':'/cache'}), (Path('/data/iris-market'), Path('/cache/iris-market')))
        self.assertEqual(APP.ORIGIN, 'http://127.0.0.1:45876')

    def test_history_gestures_navigate_only_available_entries(self):
        view = Mock()
        view.can_go_back.return_value = True
        view.can_go_forward.return_value = False
        self.assertTrue(APP.navigate_history(view, 'back'))
        view.go_back.assert_called_once_with()
        self.assertTrue(APP.navigate_history(view, 'forward'))
        view.go_forward.assert_not_called()
        view.can_go_forward.return_value = True
        self.assertTrue(APP.navigate_history(view, 'forward'))
        view.go_forward.assert_called_once_with()
        view.reset_mock()
        self.assertFalse(APP.navigate_history(view, None))
        self.assertEqual(view.mock_calls, [])


if __name__ == '__main__':
    unittest.main()
