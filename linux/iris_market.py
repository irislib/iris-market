#!/usr/bin/python3
"""Iris Market Linux desktop shell. UI and encrypted storage are the web client."""
import argparse
import functools
import http.server
import os
from pathlib import Path
import re
import shutil
import threading
from urllib.parse import unquote, urlsplit

PORT = 45876
ORIGIN = f'http://127.0.0.1:{PORT}'
ROUTES = re.compile(r'^/(?:invite|npub1[a-z0-9]+(?:/[^/]+)?|naddr1[a-z0-9]+|post|saved|messages(?:/[^/]+)?|orders(?:/[^/]+)?|wallet|courier|settings(?:/profile)?)?/?$')


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
    import gi
    gi.require_version('Gtk', '3.0')
    gi.require_version('WebKit2', '4.1')
    from gi.repository import Gtk, WebKit2, GLib
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

    def policy(_view, decision, kind):
        if kind not in (WebKit2.PolicyDecisionType.NAVIGATION_ACTION, WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION):
            return False
        uri = decision.get_navigation_action().get_request().get_uri()
        parsed = urlsplit(uri)
        if kind == WebKit2.PolicyDecisionType.NAVIGATION_ACTION and f'{parsed.scheme}://{parsed.netloc}' == ORIGIN:
            return False
        decision.ignore()
        if parsed.scheme in ('http', 'https') and f'{parsed.scheme}://{parsed.netloc}' != ORIGIN:
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
        server.shutdown()
        server.server_close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
