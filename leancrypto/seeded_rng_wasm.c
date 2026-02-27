/*
 * WASM entropy source for leancrypto
 *
 * Implements the three symbols required by seeded_rng.c on platforms
 * where no OS-specific backend (Linux/BSD/Darwin/Windows) is compiled.
 *
 * get_full_entropy() delegates to Emscripten's getentropy(), which is
 * backed by crypto.getRandomValues() in the browser and by Node.js
 * crypto.randomFillSync() in Node.
 *
 * getentropy() is capped at 256 bytes per call (POSIX requirement);
 * this wrapper loops to satisfy larger requests.
 */

#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>
#include <unistd.h> /* getentropy() via emscripten sysroot */

ssize_t get_full_entropy(uint8_t *buffer, size_t bufferlen)
{
	size_t offset = 0;

	while (offset < bufferlen) {
		/* getentropy() is limited to 256 bytes per call */
		size_t chunk = bufferlen - offset;

		if (chunk > 256)
			chunk = 256;

		if (getentropy(buffer + offset, chunk) != 0)
			return -1;

		offset += chunk;
	}

	return (ssize_t)bufferlen;
}

void seeded_rng_noise_fini(void)
{
	/* No noise source to clean up in WASM */
}

int seeded_rng_noise_init(void)
{
	/* No noise source to initialize in WASM */
	return 0;
}
