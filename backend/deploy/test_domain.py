import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, MagicMock

spec = importlib.util.spec_from_file_location('prepare_domain', Path(__file__).with_name('prepare-domain.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
preflight_spec = importlib.util.spec_from_file_location('domain_preflight', Path(__file__).with_name('domain-preflight.py'))
preflight = importlib.util.module_from_spec(preflight_spec)
preflight_spec.loader.exec_module(preflight)


class DomainMigrationTests(unittest.TestCase):
    def test_bootstrap_preserves_live_ip_and_adds_only_domain_http(self):
        bundle = module.render('coffee.example', ['www.coffee.example'], '203.0.113.10')
        text = bundle['bootstrap']
        self.assertIn('server_name coffee.example www.coffee.example;', text)
        self.assertIn('return 503 "Domain HTTPS setup', text)
        self.assertIn('include /etc/nginx/snippets/dao-site.conf;', text)
        self.assertIn('https://203.0.113.10$request_uri', text)
        self.assertNotIn('/live/dao-domain/', text)
        self.assertEqual(text.count('listen 443 ssl default_server;'), 1)
        self.assertEqual(text.count('include /etc/nginx/snippets/dao-acme.conf;'), 2)

    def test_final_keeps_ip_acme_and_tls_and_canonicalizes_alias(self):
        text = module.render('coffee.example', ['www.coffee.example'], '203.0.113.10')['https']
        self.assertEqual(text.count('listen 443 ssl default_server;'), 1)
        self.assertIn('/live/dao-ip/fullchain.pem;', text)
        self.assertEqual(text.count('include /etc/nginx/snippets/dao-acme.conf;'), 2)
        self.assertIn('server_name www.coffee.example;', text)
        self.assertIn('/live/dao-domain/fullchain.pem;', text)
        self.assertIn('return 308 https://coffee.example$request_uri;', text)
        self.assertNotIn('https://203.0.113.10$request_uri', text)
        self.assertNotIn('ssl_reject_handshake on;', text)

        self.assertNotIn('Disallow: /', text)
        self.assertNotIn('return 503', text)
        self.assertEqual(text.count('include /etc/nginx/snippets/dao-site.conf;'), 1)

    def test_no_implicit_www_and_no_config_injection(self):
        text = module.render('coffee.example', [], '203.0.113.10')['https']
        self.assertNotIn('www.', text)
        for invalid in ['https://coffee.example', 'coffee.example;', 'coffee.example\nlisten 9', '*.coffee.example', '127.0.0.1', 'a..example', '-a.example', 'coffee.example:443', 'кофе.рф']:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                module.render(invalid, [], '203.0.113.10')
        with self.assertRaises(ValueError):
            module.render('coffee.example', ['coffee.example'], '203.0.113.10')
        for invalid in ['::1', '127.0.0.1', '1.2.3.4;', '0.0.0.0']:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                module.render('coffee.example', [], invalid)

    def test_post_activation_rollback_keeps_domain_tls_and_ip_site(self):
        text = module.render('coffee.example', ['www.coffee.example'], '203.0.113.10')['rollback']
        self.assertIn('/live/dao-ip/fullchain.pem;', text)
        self.assertIn('/live/dao-domain/fullchain.pem;', text)
        self.assertIn('server_name coffee.example www.coffee.example;', text)
        self.assertEqual(text.count('include /etc/nginx/snippets/dao-acme.conf;'), 2)
        self.assertEqual(text.count('include /etc/nginx/snippets/dao-site.conf;'), 1)
        self.assertIn('return 307 https://203.0.113.10$request_uri;', text)
        self.assertNotIn('return 503', text)
        self.assertNotIn('ssl_reject_handshake on;', text)

    def test_reversible_redirects_cannot_be_cached_as_permanent(self):
        bundle = module.render('coffee.example', ['www.coffee.example'], '203.0.113.10')
        ip_redirects = bundle['https'].split('server_name coffee.example')[0]
        self.assertEqual(ip_redirects.count('return 307 https://coffee.example$request_uri;'), 2)
        self.assertEqual(ip_redirects.count('add_header Cache-Control no-store always;'), 2)
        domain_rollback = bundle['rollback'].split('server_name coffee.example', 1)[1]
        self.assertEqual(domain_rollback.count('return 307 https://203.0.113.10$request_uri;'), 2)
        self.assertEqual(domain_rollback.count('add_header Cache-Control no-store always;'), 2)
        self.assertNotIn('return 308', domain_rollback)


class DomainPreflightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'domain.json').write_text(json.dumps({'domain': 'coffee.example', 'aliases': ['www.coffee.example'], 'ipv4': '203.0.113.10'}))
        self.challenge = self.root / '.well-known/acme-challenge'
        self.challenge.mkdir(parents=True)
        self.argv = ['domain-preflight.py', str(self.root), '--webroot', str(self.root)]

    def test_wrong_dns_prevents_certificate_request(self):
        with patch('sys.argv', self.argv + ['--issue']), patch.object(preflight.socket, 'getaddrinfo', return_value=[(None,None,None,None,('198.51.100.1',80))]), patch.object(preflight.subprocess, 'run') as issue:
            with self.assertRaisesRegex(SystemExit, 'DNS not ready'):
                preflight.main()
            issue.assert_not_called()
            self.assertEqual(list(self.challenge.iterdir()), [])

    def test_probe_collision_does_not_remove_existing_file(self):
        existing = self.challenge / 'dao-preflight-collision'
        existing.write_text('unrelated existing challenge')
        with patch('sys.argv', self.argv), patch.object(preflight.socket, 'getaddrinfo', return_value=[(None,None,None,None,('203.0.113.10',80))]), patch.object(preflight.secrets, 'token_hex', return_value='collision'):
            with self.assertRaises(FileExistsError):
                preflight.main()
        self.assertEqual(existing.read_text(), 'unrelated existing challenge')

    def test_success_cleans_probe_and_only_explicit_flag_issues(self):
        response = MagicMock(status=200)
        response.read.return_value = b'dao-preflight-success'
        for flag in ([], ['--issue']):
            with self.subTest(flag=flag), patch('sys.argv', self.argv + flag), patch.object(preflight.socket, 'getaddrinfo', return_value=[(None,None,None,None,('203.0.113.10',80))]), patch.object(preflight.secrets, 'token_hex', return_value='success'), patch.object(preflight.http.client, 'HTTPConnection') as connection, patch.object(preflight.subprocess, 'run') as issue:
                connection.return_value.getresponse.return_value = response
                preflight.main()
                self.assertEqual(list(self.challenge.iterdir()), [])
                self.assertEqual(connection.call_count, 2)
                if flag:
                    issue.assert_called_once()
                    command = issue.call_args.args[0]
                    self.assertEqual(command[0], '/opt/dao-certbot/bin/certbot')
                    self.assertEqual(command[-4:], ['-d','coffee.example','-d','www.coffee.example'])
                else:
                    issue.assert_not_called()



if __name__ == '__main__':
    unittest.main()
