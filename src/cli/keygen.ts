import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export type SigningKey = {
  keyId: string
  publicKey: string
  privateKey: string
}

/**
 * Generate the signing key for the machine user behind `signed-rebase`.
 *
 * GitHub only marks a commit "Verified" when the signing key is registered on
 * a real user account whose verified email matches the committer. This
 * generates that key locally; the public half goes on the machine user's
 * account and the private half becomes a repository or organisation secret.
 * Neither half is ever sent anywhere by this command.
 */
export async function generateSigningKey(options: {
  name: string
  email: string
  passphrase?: string
}): Promise<SigningKey> {
  const home = await mkdtemp(join(tmpdir(), 'tidebot-gpg-'))
  try {
    const paramsPath = join(home, 'params')
    await writeFile(
      paramsPath,
      [
        'Key-Type: eddsa',
        'Key-Curve: ed25519',
        'Key-Usage: sign',
        `Name-Real: ${options.name}`,
        `Name-Email: ${options.email}`,
        'Expire-Date: 0',
        options.passphrase
          ? `Passphrase: ${options.passphrase}`
          : '%no-protection',
        '%commit',
      ].join('\n'),
      { mode: 0o600 },
    )

    const env = { ...process.env, GNUPGHOME: home }
    await run('gpg', ['--batch', '--generate-key', paramsPath], { env })

    const { stdout: colons } = await run(
      'gpg',
      ['--list-secret-keys', '--with-colons'],
      { env },
    )
    const keyId = colons
      .split('\n')
      .find((line) => line.startsWith('sec:'))
      ?.split(':')[4]
    if (!keyId) {
      throw new Error('gpg did not report a key id')
    }

    // --passphrase-file, not --passphrase: an argv passphrase is readable
    // from the process list by any other user on the machine.
    let exportArgs = ['--batch']
    if (options.passphrase) {
      const passphrasePath = join(home, 'passphrase')
      await writeFile(passphrasePath, options.passphrase, { mode: 0o600 })
      exportArgs = [
        '--batch',
        '--pinentry-mode',
        'loopback',
        '--passphrase-file',
        passphrasePath,
      ]
    }

    const [{ stdout: publicKey }, { stdout: privateKey }] = await Promise.all([
      run('gpg', [...exportArgs, '--armor', '--export', keyId], { env }),
      run('gpg', [...exportArgs, '--armor', '--export-secret-keys', keyId], {
        env,
        maxBuffer: 1024 * 1024,
      }),
    ])

    return { keyId, publicKey, privateKey }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
