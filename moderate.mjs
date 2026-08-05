#!/usr/bin/env node
import { readFileSync } from 'node:fs';

function envFileValue(pathname, wanted) {
  try {
    for (const line of readFileSync(pathname, 'utf8').split(/\r?\n/)) {
      const split = line.indexOf('=');
      if (split !== -1 && line.slice(0, split) === wanted) return line.slice(split + 1);
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  return '';
}

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    'Usage:\n' +
    '  nuketown-admin players\n' +
    '  nuketown-admin kick <name-or-peer-id> [reason]\n' +
    '  nuketown-admin ban <name-or-peer-id> [reason]\n' +
    '  nuketown-admin bans\n' +
    '  nuketown-admin unban <ban-id>\n'
  );
  process.exitCode = message ? 2 : 0;
}

function printPlayers(players) {
  if (!players.length) {
    process.stdout.write('No players online.\n');
    return;
  }
  for (const player of players) {
    process.stdout.write(
      `${player.id}  ${player.name}  room=${player.room}  ${player.role}` +
      `  account=${player.signedIn ? 'yes' : 'no'}  network=${player.network || '-'}\n`
    );
  }
}

function printBans(bans) {
  if (!bans.length) {
    process.stdout.write('No active bans.\n');
    return;
  }
  for (const ban of bans) {
    process.stdout.write(
      `${ban.id}  ${ban.name || '(unknown name)'}  ${ban.createdAt}` +
      `  account=${ban.account || '-'}  network=${ban.network || '-'}` +
      `${ban.reason ? `  reason=${ban.reason}` : ''}\n`
    );
  }
}

async function main() {
  const [command, selector, ...reasonParts] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    usage();
    return;
  }
  if (!['players', 'kick', 'ban', 'bans', 'unban'].includes(command)) {
    usage(`Unknown command: ${command}`);
    return;
  }
  if (['kick', 'ban', 'unban'].includes(command) && !selector) {
    usage(`${command} requires a target.`);
    return;
  }

  const token = process.env.ADMIN_TOKEN || envFileValue('/etc/nuketown.env', 'ADMIN_TOKEN');
  if (!token) throw new Error('ADMIN_TOKEN is not set and was not found in /etc/nuketown.env.');
  const port = process.env.PORT || '8080';
  const base = (process.env.NUKETOWN_ADMIN_URL || `http://127.0.0.1:${port}/admin`)
    .replace(/\/+$/, '');
  const listCommand = command === 'players' || command === 'bans';
  const response = await fetch(`${base}/${command}`, {
    method: listCommand ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(listCommand ? {} : { 'content-type': 'application/json' })
    },
    ...(listCommand ? {} : {
      body: JSON.stringify({
        selector,
        ...(reasonParts.length ? { reason: reasonParts.join(' ') } : {})
      })
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (Array.isArray(body.candidates)) printPlayers(body.candidates);
    if (Array.isArray(body.matches)) printBans(body.matches);
    throw new Error(body.message || `Relay returned HTTP ${response.status}.`);
  }

  if (command === 'players') printPlayers(body.players || []);
  else if (command === 'bans') printBans(body.bans || []);
  else if (command === 'unban') process.stdout.write(`Unbanned ${body.ban.name || body.ban.id}.\n`);
  else process.stdout.write(`${command === 'ban' ? 'Banned' : 'Kicked'} ${body.player.name}.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
