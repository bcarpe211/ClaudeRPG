function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

const INSTALL_URL = 'https://raiders.redlattice.com/install.sh';

export function buildCompanionInstallCommand(): string {
  return [
    '(umask 077;',
    'installer="$(mktemp)" || exit 1;',
    'cleanup() { rm -f "$installer"; };',
    'trap cleanup EXIT;',
    "trap 'exit 129' HUP;",
    "trap 'exit 130' INT;",
    "trap 'exit 143' TERM;",
    'status="$(curl --fail --silent --show-error',
    "--proto '=https'",
    "--proto-redir '=https'",
    '--max-redirs 0',
    '--connect-timeout 10',
    '--max-time 30',
    '--max-filesize 1048576',
    '--output "$installer"',
    "--write-out '%{http_code}'",
    shellQuote(INSTALL_URL),
    ')"',
    '&& [ "$status" = 200 ]',
    '&& test -s "$installer"',
    '&& sh "$installer")',
  ].join(' ');
}
