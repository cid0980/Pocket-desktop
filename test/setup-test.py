#!/usr/bin/env python3
"""Installer command/guard tests: never run a package manager or change the host."""
import os
import subprocess
import unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
def run(script, *args, env=None):
    return subprocess.run(['bash', str(ROOT / script), *args], cwd=ROOT,
                          capture_output=True, text=True, env=env)
class SetupTests(unittest.TestCase):
    def test_shell_syntax(self):
        for script in ['setup.sh', 'run.sh', 'install.sh', 'tools/install-deps.sh']:
            self.assertEqual(subprocess.run(['bash', '-n', str(ROOT/script)]).returncode, 0)
    def test_apt(self):
        r=run('tools/install-deps.sh','--plan','--manager','apt')
        self.assertEqual(r.returncode,0); self.assertIn('apt-get install',r.stdout)
        self.assertIn('python3',r.stdout); self.assertIn('acl',r.stdout)
    def test_dnf(self):
        r=run('tools/install-deps.sh','--plan','--manager','dnf')
        self.assertEqual(r.returncode,0); self.assertIn('dnf install',r.stdout);self.assertIn('ImageMagick',r.stdout)
    def test_pacman(self):
        r=run('tools/install-deps.sh','--plan','--manager','pacman')
        self.assertEqual(r.returncode,0); self.assertIn('pacman -Syu --needed',r.stdout)
        self.assertNotIn('--noconfirm',r.stdout)
    def test_zypper(self):
        r=run('tools/install-deps.sh','--plan','--manager','zypper')
        self.assertEqual(r.returncode,0);self.assertIn('zypper refresh',r.stdout)
    def test_unknown_manager(self):
        self.assertNotEqual(run('tools/install-deps.sh','--plan','--manager','fake').returncode,0)
    def test_default_plan(self):
        r=run('setup.sh','--plan'); self.assertEqual(r.returncode,0)
        self.assertIn('foreground',r.stdout);self.assertIn('8765',r.stdout)
    def test_custom_port(self):
        r=run('setup.sh','--plan','--skip-deps','--port','9000')
        self.assertEqual(r.returncode,0);self.assertIn('9000',r.stdout);self.assertNotIn('apt-get',r.stdout)
    def test_bad_ports(self):
        for p in ['0','22','65536','abc','1; echo BAD','999999999999999999']:
            self.assertNotEqual(run('setup.sh','--plan','--port',p).returncode,0)
    def test_autostart_plan(self):
        r=run('setup.sh','--plan','--autostart'); self.assertIn('systemd',r.stdout)
    def test_install_only_plan(self):
        r=run('setup.sh','--plan','--install-only');self.assertIn('do not start',r.stdout)
    def test_unknown_argument(self):
        self.assertNotEqual(run('setup.sh','--no-such-option').returncode,0)
    @unittest.skipIf(os.geteuid()==0,'requires normal-user context')
    def test_wayland_guard(self):
        env=dict(os.environ,XDG_SESSION_TYPE='wayland',DISPLAY=':99')
        r=run('setup.sh','--skip-deps','--install-only',env=env)
        self.assertNotEqual(r.returncode,0);self.assertIn('Wayland detected',r.stderr)
    @unittest.skipIf(os.geteuid()==0,'requires normal-user context')
    def test_headless_guard(self):
        env=dict(os.environ,XDG_SESSION_TYPE='x11');env.pop('DISPLAY',None)
        r=run('setup.sh','--skip-deps','--install-only',env=env)
        self.assertNotEqual(r.returncode,0);self.assertIn('No desktop DISPLAY',r.stderr)
if __name__=='__main__': unittest.main(verbosity=2)
