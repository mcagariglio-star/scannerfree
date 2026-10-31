"""Servidor para probar ScanerFree en la PC y desde el celular en la misma red Wi-Fi.

    python herramientas/servidor.py          (puerto 8030)

Sirve la carpeta de la app tal cual; no guarda ni registra nada de lo que se escanea (eso nunca sale del celular).
"""
import functools
import http.server
import os
import socket
import sys

PUERTO = int(sys.argv[1]) if len(sys.argv) > 1 else 8030
CARPETA = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Manejador(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json",
                      ".woff2": "font/woff2", ".gz": "application/gzip", ".svg": "image/svg+xml"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass


def ip_local():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


if __name__ == "__main__":
    servidor = http.server.ThreadingHTTPServer(("0.0.0.0", PUERTO), functools.partial(Manejador, directory=CARPETA))
    print(f"ScanerFree en http://localhost:{PUERTO}  (desde el celular: http://{ip_local()}:{PUERTO})", flush=True)
    servidor.serve_forever()
