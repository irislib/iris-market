#!/usr/bin/python3
"""Iris Market Linux desktop shell. UI and encrypted storage are the web client."""
import argparse
import functools
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time
from urllib.parse import unquote, urlsplit

PORT = 45876
ORIGIN = f'http://127.0.0.1:{PORT}'
ROUTES = re.compile(r'^/(?:invite|npub1[a-z0-9]+(?:/[^/]+)?|naddr1[a-z0-9]+|post|saved|messages(?:/[^/]+)?|orders(?:/[^/]+)?|wallet|courier|settings(?:/profile)?)?/?$')


class UpdateClient:
    """Own one Rust session so download uses the release the user checked."""
    def __init__(self, root, data, downloads):
        self.root, self.data, self.downloads = Path(root), Path(data), Path(downloads)
        self.process = None
        self.result = None
        self.preferences = {'automatic': True, 'lastAttempt': 0}
        try:
            self.preferences.update(json.loads((self.data / 'preferences.json').read_text()))
        except FileNotFoundError:
            pass
        self.version = json.loads((self.root / 'build-manifest.json').read_text())['version']

    def save(self):
        self.data.mkdir(parents=True, exist_ok=True)
        temporary = self.data / 'preferences.tmp'
        temporary.write_text(json.dumps(self.preferences))
        temporary.replace(self.data / 'preferences.json')

    def due(self, now=None):
        return self.preferences['automatic'] and (time.time() if now is None else now) - self.preferences['lastAttempt'] >= 86400

    def request(self, operation):
        if operation not in ('check', 'download'):
            raise ValueError('Unknown update operation')
        if operation == 'check':
            self.result = None
            self.preferences['lastAttempt'] = time.time()
            self.save()
        elif not self.result or not self.result.get('available'):
            raise ValueError('Check for updates before downloading')
        if self.process is None:
            self.process = subprocess.Popen([str(self.root / 'iris-market-updater'), 'update', 'serve', str(self.data),
                '--app', '--current-version', self.version, '--output', str(self.downloads)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        try:
            self.process.stdin.write(operation + '\n')
            self.process.stdin.flush()
            line = self.process.stdout.readline(16385)
            if not line.endswith('\n') or len(line) > 16384:
                raise ValueError('Update helper stopped unexpectedly. Check again.')
            response = json.loads(line)
            if response.get('ok') is not True:
                raise ValueError(response.get('error', 'Update failed. Try again.'))
            result = response['result']
            if result.get('verified') is not True:
                raise ValueError('The update could not be verified')
            self.result = result
            return result
        except (OSError, ValueError):
            self.close()
            raise

    def download_uri(self):
        if not self.result or not self.result.get('path'):
            raise ValueError('Download an update first')
        path = Path(self.result['path']).resolve()
        if not path.is_relative_to(self.downloads.resolve()) or not path.is_file():
            raise ValueError('The downloaded update is missing')
        return path.as_uri()

    def close(self):
        if self.process is not None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
            self.process = None
        self.result = None


def configure_webkit_environment(environ=None):
    env = os.environ if environ is None else environ
    # WebKitGTK's optimizing WASM tier can exceed 8 GiB while compiling the
    # pinned asyncify runtime. Keep baseline WASM/JavaScript JITs enabled.
    # Process-local defaults preserve deliberate launcher overrides.
    env.setdefault('JSC_useOMGJIT', 'false')
    env.setdefault('JSC_numberOfWasmCompilerThreads', '1')


def profile_paths(environ=None):
    env = os.environ if environ is None else environ
    home = Path(env.get('HOME', str(Path.home())))
    return (Path(env.get('XDG_DATA_HOME', home / '.local/share')) / 'iris-market',
            Path(env.get('XDG_CACHE_HOME', home / '.cache')) / 'iris-market')


def browser_languages(names):
    languages = []
    for name in names:
        language = name.split('.')[0].split('@')[0].replace('_', '-')
        if language not in ('C', 'POSIX') and language not in languages:
            languages.append(language)
    return languages or ['en-US']


def external_uri_allowed(uri):
    parsed = urlsplit(uri)
    if parsed.scheme in ('http', 'https'):
        return bool(parsed.netloc) and f'{parsed.scheme}://{parsed.netloc}' != ORIGIN
    # An explicit invoice link may hand off to the user's Lightning wallet.
    # Never launch arbitrary custom protocols supplied by marketplace content.
    return bool(re.fullmatch(r'lightning:ln(?:bc|tb|bcrt)[0-9]*[munp]?1[023456789acdefghjklmnpqrstuvwxyz]{90,4096}', uri, re.IGNORECASE))


def navigate_history(view, direction):
    """Consume a desktop history gesture, including at either end of history."""
    if direction == 'back':
        if view.can_go_back():
            view.go_back()
        return True
    if direction == 'forward':
        if view.can_go_forward():
            view.go_forward()
        return True
    return False


class AssetHandler(http.server.BaseHTTPRequestHandler):
    def __init__(self, *args, directory, **kwargs):
        self.root = Path(directory).resolve()
        super().__init__(*args, **kwargs)

    def log_message(self, *args):
        pass  # Request paths may contain private conversation identifiers.

    def do_HEAD(self):
        self.serve(head=True)

    def do_GET(self):
        self.serve()

    def serve(self, head=False):
        # Never serve to arbitrary DNS names (including DNS-rebinding hosts).
        if self.headers.get('Host') != ORIGIN.removeprefix('http://'):
            self.send_error(403)
            return
        try:
            pathname = unquote(urlsplit(self.path).path, errors='strict')
            target = (self.root / pathname.lstrip('/')).resolve()
            if not target.is_relative_to(self.root):
                self.send_error(403)
                return
            if pathname == '/sw.js':
                # Desktop ships its assets. Retire any old service worker on upgrades.
                data = b"self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.registration.unregister()));"
                mime = 'text/javascript'
            else:
                if not target.is_file() and ROUTES.fullmatch(pathname):
                    target = self.root / 'index.html'
                if not target.is_file() or target.name == '_headers':
                    self.send_error(404)
                    return
                data = target.read_bytes()
                mime = {'.js':'text/javascript', '.mjs':'text/javascript', '.wasm':'application/wasm',
                        '.html':'text/html', '.css':'text/css', '.svg':'image/svg+xml',
                        '.json':'application/json', '.webmanifest':'application/manifest+json',
                        '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg'}.get(target.suffix, 'application/octet-stream')
            self.send_response(200)
            for line in (self.root / '_headers').read_text().splitlines():
                if line.startswith('  ') and ': ' in line:
                    key, value = line.strip().split(': ', 1)
                    self.send_header(key, value)
            self.send_header('Content-Type', mime)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            if not head:
                self.wfile.write(data)
        except (OSError, UnicodeError, ValueError):
            self.send_error(404)


def make_server(directory):
    return http.server.ThreadingHTTPServer(('127.0.0.1', PORT), functools.partial(AssetHandler, directory=directory))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets', type=Path, default=Path(__file__).resolve().parent / 'web')
    args = parser.parse_args()
    if not (args.assets / 'index.html').is_file() or not (args.assets / '_headers').is_file():
        parser.error('Bundled web assets are missing.')
    configure_webkit_environment()
    import gi
    gi.require_version('Gtk', '3.0')
    gi.require_version('WebKit2', '4.1')
    from gi.repository import Gtk, WebKit2, GLib, Gdk
    GLib.set_prgname('iris-market')
    GLib.set_application_name('Iris Market')
    try:
        server = make_server(args.assets)
    except OSError:
        dialog = Gtk.MessageDialog(message_type=Gtk.MessageType.ERROR, buttons=Gtk.ButtonsType.CLOSE,
                                   text='Iris Market cannot start', secondary_text='Another Iris Market window may already be open. Close it and try again.')
        dialog.run()
        dialog.destroy()
        return 1
    data, cache = profile_paths()
    for folder in (data, cache):
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        folder.chmod(0o700)
    volume_bytes = shutil.disk_usage(data).total
    manager = WebKit2.WebsiteDataManager(base_data_directory=str(data), base_cache_directory=str(cache),
                                        origin_storage_ratio=min(1.0, 2 * 1024**3 / volume_bytes),
                                        total_storage_ratio=min(1.0, 3 * 1024**3 / volume_bytes))
    context = WebKit2.WebContext.new_with_website_data_manager(manager)
    context.set_cache_model(WebKit2.CacheModel.DOCUMENT_BROWSER)
    # GLib includes the POSIX C locale, which is not a valid browser language tag.
    context.set_preferred_languages(browser_languages(GLib.get_language_names()))
    view = WebKit2.WebView.new_with_context(context)
    view.get_settings().set_enable_developer_extras(False)
    window = Gtk.Window(title='Iris Market')
    window.set_default_size(1180, 800)
    window.set_icon_name('iris-market')
    window.add(view)
    window.connect('destroy', Gtk.main_quit)

    update_state = {'busy': False, 'error': None, 'result': None}
    updates = None
    try:
        updates = UpdateClient(Path(__file__).resolve().parent, data / 'updates', Path(GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) or str(Path.home() / 'Downloads')) / 'Iris Market Updates')
    except (OSError, ValueError, KeyError):
        pass  # Source-only launches may lack a packaged updater and version.

    def update_emit():
        if updates is not None:
            state = {**update_state, 'version': updates.version, 'automatic': updates.preferences['automatic']}
            view.run_javascript('window.dispatchEvent(new CustomEvent("market-update", {detail:' + json.dumps(state) + '}));', None, None, None)
        return False

    def update_action(_manager, message):
        start_update(message.get_js_value().to_string())

    def start_update(action):
        if updates is None or not (view.get_uri() or '').startswith(ORIGIN + '/'):
            return
        if action == 'state':
            update_emit()
            return
        if 'preview=1' in (view.get_uri() or ''):
            return
        if action in ('automatic:on', 'automatic:off'):
            updates.preferences['automatic'] = action == 'automatic:on'
            try:
                updates.save()
            except OSError:
                update_state['error'] = 'Could not save update preferences.'
            update_emit()
            return
        if update_state['busy']:
            return
        if action == 'open':
            try:
                Gtk.show_uri_on_window(window, updates.download_uri(), 0)
            except (OSError, ValueError) as error:
                update_state['error'] = str(error)
                update_emit()
            return
        if action not in ('check', 'download'):
            return
        update_state.update(busy=True, downloading=action == 'download', error=None)
        if action == 'check':
            update_state['result'] = None
        update_emit()

        def work():
            try:
                result, error = updates.request(action), None
            except (OSError, ValueError, KeyError) as failure:
                result, error = None, str(failure)
            def complete():
                update_state.update(busy=False, result=result, error=error)
                update_emit()
                return False
            GLib.idle_add(complete)
        threading.Thread(target=work, daemon=True).start()

    def updates_loaded(_view, event):
        if updates is None or event != WebKit2.LoadEvent.FINISHED:
            return
        if not (view.get_uri() or '').startswith(ORIGIN + '/'):
            return
        script = (Path(__file__).resolve().parent / 'updates.js').read_text()
        view.run_javascript(script, None, None, None)
        if updates.due() and 'preview=1' not in (view.get_uri() or ''):
            start_update('check')

    if updates is not None:
        content = view.get_user_content_manager()
        content.register_script_message_handler('marketUpdates')
        content.connect('script-message-received::marketUpdates', update_action)
        view.connect('load-changed', updates_loaded)
        def update_focus(_window, _event):
            if updates.due(): start_update('check')
            return False
        window.connect('focus-in-event', update_focus)

    def history_key(_window, event):
        modifiers = event.state & Gtk.accelerator_get_default_mod_mask()
        if modifiers != Gdk.ModifierType.MOD1_MASK:
            return False
        direction = {Gdk.KEY_Left: 'back', Gdk.KEY_Right: 'forward'}.get(event.keyval)
        return navigate_history(view, direction)

    def history_button(_view, event):
        return navigate_history(view, {8: 'back', 9: 'forward'}.get(event.button))

    # Match browser/PWA navigation without adding a second toolbar to the app.
    window.connect('key-press-event', history_key)
    view.connect('button-press-event', history_button)

    def policy(_view, decision, kind):
        if kind not in (WebKit2.PolicyDecisionType.NAVIGATION_ACTION, WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION):
            return False
        uri = decision.get_navigation_action().get_request().get_uri()
        parsed = urlsplit(uri)
        if kind == WebKit2.PolicyDecisionType.NAVIGATION_ACTION and f'{parsed.scheme}://{parsed.netloc}' == ORIGIN:
            return False
        decision.ignore()
        if external_uri_allowed(uri):
            Gtk.show_uri_on_window(window, uri, 0)
        return True

    def download_started(_context, download):
        def destination(_download, suggested):
            chooser = Gtk.FileChooserDialog(title='Save file', parent=window, action=Gtk.FileChooserAction.SAVE)
            chooser.add_buttons('Cancel', Gtk.ResponseType.CANCEL, 'Save', Gtk.ResponseType.ACCEPT)
            chooser.set_do_overwrite_confirmation(True)
            chooser.set_current_name(Path(suggested).name)
            if chooser.run() == Gtk.ResponseType.ACCEPT:
                download.set_destination(GLib.filename_to_uri(chooser.get_filename(), None))
            else:
                download.cancel()
            chooser.destroy()
            return True
        download.connect('decide-destination', destination)

    view.connect('decide-policy', policy)
    context.connect('download-started', download_started)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    window.show_all()
    view.load_uri(ORIGIN + '/')
    try:
        Gtk.main()
    finally:
        if updates is not None:
            updates.close()
        server.shutdown()
        server.server_close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
