import artifactContract from '../../config/runtime-raiders-artifact-contract.json';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

const INSTALL_URL = 'https://raiders.redlattice.com/install.sh';

export function buildCompanionInstallCommand(
  options: { curlPath?: string } = {},
): string {
  const curlPath = options.curlPath ?? '/usr/bin/curl';
  return [
    '(umask 077;',
    'installer="$(/usr/bin/mktemp)" || exit 1;',
    'cleanup() { /bin/rm -f "$installer"; };',
    'trap cleanup EXIT;',
    "trap 'exit 129' HUP;",
    "trap 'exit 130' INT;",
    "trap 'exit 143' TERM;",
    `download_http_code="$(${shellQuote(curlPath)} --fail --silent --show-error`,
    "--proto '=https'",
    "--proto-redir '=https'",
    '--max-redirs 0',
    '--connect-timeout 10',
    '--max-time 30',
    `--max-filesize ${artifactContract.installer_max_bytes}`,
    '--output "$installer"',
    "--write-out '%{http_code}'",
    shellQuote(INSTALL_URL),
    ')"',
    '&& [ "$download_http_code" = 200 ]',
    '&& test -f "$installer"',
    '&& test ! -L "$installer"',
    '&& [ "$(/usr/bin/stat -f \'%u\' "$installer")" = "$(/usr/bin/id -u)" ]',
    '&& [ "$(/usr/bin/stat -f \'%Lp\' "$installer")" = 600 ]',
    '&& [ "$(/usr/bin/stat -f \'%l\' "$installer")" = 1 ]',
    '&& test -s "$installer"',
    '&& bytes="$(/usr/bin/wc -c < "$installer" | /usr/bin/tr -d \' \')"',
    `&& [ "$bytes" -le ${artifactContract.installer_max_bytes} ]`,
    '&& /bin/sh -n "$installer"',
    '&& /bin/sh "$installer")',
  ].join(' ');
}
