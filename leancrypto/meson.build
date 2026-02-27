################################################################################
# leancrypto WASM build
#
# Usage:
#   cp meson.build.wasm meson.build
#   meson setup build-wasm --cross-file wasm-cross.ini \
#         -Ddisable-asm=true -Defi=disabled -Dtests=disabled
#   ninja -C build-wasm
#
# Required cross file (wasm-cross.ini):
#   [binaries]
#   c     = 'emcc'
#   ar    = 'emar'
#   strip = 'emstrip'
#   [host_machine]
#   system     = 'emscripten'
#   cpu_family = 'wasm32'
#   cpu        = 'wasm32'
#   endian     = 'little'
#
# Differences from meson.build:
#   - Linux/macOS/Windows platform hardening flags removed (not supported by emcc)
#   - LTO removed (emcc uses its own LLVM LTO model)
#   - ASM always disabled (no x86/ARM/RISC-V asm in WASM)
#   - Shared libraries always disabled (WASM uses static archives or modules)
#   - FIPS 140 ELF integrity checker disabled (Linux ELF specific)
#   - EFI support disabled
#   - Secure execution (Linux SE) disabled
#   - Apps and Doxygen skipped
#   - Tests optionally skipped via -Dtests=disabled
################################################################################

################################################################################
# Version Change Definition
################################################################################
project('leancrypto', 'c',
	version: '1.6.0',
	default_options: [
		'warning_level=3',
		'optimization=3',
		'strip=true',
		'b_staticpic=false',
		'b_pie=false',
		'b_asneeded=false',
	])

cc = meson.get_compiler('c')

if host_machine.cpu_family() != 'wasm32'
	warning('meson.build.wasm is intended for wasm32 targets. ' +
		'Got cpu_family=' + host_machine.cpu_family())
endif

################################################################################
# Compiler flags — WASM-compatible subset
# emcc is clang-based; flags requiring OS/CPU features are excluded:
#   removed: -fstack-protector-strong, --param ssp-buffer-size=4
#            -fzero-call-used-regs=used-gpr  (not supported by emcc)
#            -fcf-protection=full            (x86 only)
#            -mbranch-protection=standard    (ARM only)
#            -flto=auto / -ffat-lto-objects  (use emcc's own LTO)
#            -D_FORTIFY_SOURCE               (glibc feature, no-op in WASM)
################################################################################

add_global_arguments([
		'-fwrapv',
		'-fvisibility=hidden',
		'-Wconversion',
		'-Wcast-align',
		'-Wmissing-field-initializers',
		'-Wshadow',
		'-Wswitch-enum',
		'-Wmissing-prototypes',
		'-Wformat=2',
		'-fno-delete-null-pointer-checks',
		'-fno-strict-aliasing',
		'-Wundef',
		'-Wvla',
		'-Wunused-function',
		'-Wunused-parameter',
		'-Wunreachable-code',
	],
	language: 'c')

# These are clang-supported but check anyway
foreach arg : [
	'-Wdocumentation',
	'-ftrivial-auto-var-init=zero',
	'-Wshorten-64-to-32',
	]
	if cc.has_argument(arg)
		add_global_arguments([arg], language: 'c')
	endif
endforeach

# Dead-code stripping — emcc/wasm-ld respects these
add_global_arguments(['-ffunction-sections', '-fdata-sections'], language: 'c')

################################################################################
# Feature flags (identical to meson.build)
################################################################################

if get_option('optimization') == '0'
	add_global_arguments(['-DDEBUG'], language: 'c')
endif

if get_option('enable_selftests').enabled()
	add_global_arguments(['-DLC_SELFTEST_ENABLED'], language: 'c')
endif

if get_option('small_stack').enabled()
	add_global_arguments([
			'-Wframe-larger-than=2048',
			'-DLC_MEM_ON_HEAP',
		],
		language: 'c')
else
	add_global_arguments(['-Wframe-larger-than=1048576'], language: 'c')
endif

if get_option('debug')
	add_global_arguments(['-DLC_DEBUG'], language: 'c')
endif
if get_option('dilithium_debug').enabled()
	add_global_arguments(['-DLC_DILITHIUM_DEBUG'], language: 'c')
endif
if get_option('kyber_debug').enabled()
	add_global_arguments(['-DLC_KYBER_DEBUG'], language: 'c')
endif

if get_option('sha2-256').enabled()
	add_global_arguments(['-DLC_SHA2_256'], language: 'c')
endif
if get_option('sha2-512').enabled()
	add_global_arguments(['-DLC_SHA2_512'], language: 'c')
endif
if get_option('hmac').enabled()
	add_global_arguments(['-DLC_HMAC'], language: 'c')
endif

fips_integrity_test_capable = true
if get_option('sha3').enabled()
	add_global_arguments(['-DLC_SHA3'], language: 'c')
else
	fips_integrity_test_capable = false
	message('FIPS 140 integrity checker disabled due to missing SHA-3 support')
endif

if get_option('kmac').enabled()
	add_global_arguments(['-DLC_KMAC'], language: 'c')
endif

if get_option('ascon').enabled()
	add_global_arguments(['-DLC_ASCON_HASH'], language: 'c')
endif
if get_option('ascon_keccak').enabled()
	add_global_arguments(['-DLC_ASCON_KECCAK'], language: 'c')
endif

if get_option('chacha20').enabled()
	add_global_arguments(['-DLC_CHACHA20'], language: 'c')
endif
if get_option('chacha20poly1305').enabled()
	add_global_arguments(['-DLC_CHACHA20_POLY1305'], language: 'c')
endif

kyber_enabled = false
if (get_option('kyber_1024').enabled() or
    get_option('kyber_768').enabled() or
    get_option('kyber_512').enabled())
	add_global_arguments(['-DLC_KYBER'], language: 'c')
	kyber_enabled = true
endif

hqc_enabled = false
if (get_option('hqc_256').enabled() or
    get_option('hqc_192').enabled() or
    get_option('hqc_128').enabled())
	add_global_arguments(['-DLC_HQC'], language: 'c')
	hqc_enabled = true
endif

dilithium_enabled = false
if (get_option('dilithium_87').enabled() or
    get_option('dilithium_65').enabled() or
    get_option('dilithium_44').enabled())
	add_global_arguments(['-DLC_DILITHIUM'], language: 'c')
	dilithium_enabled = true
endif

if get_option('dilithium_87').enabled()
	add_global_arguments(['-DLC_DILITHIUM_87_OPT_ENABLED'], language: 'c')
endif
if get_option('dilithium_65').enabled()
	add_global_arguments(['-DLC_DILITHIUM_65_OPT_ENABLED'], language: 'c')
endif
if get_option('dilithium_44').enabled()
	add_global_arguments(['-DLC_DILITHIUM_44_OPT_ENABLED'], language: 'c')
endif

sphincs_enabled = false
if (get_option('sphincs_shake_256s').enabled() or
    get_option('sphincs_shake_256f').enabled() or
    get_option('sphincs_shake_192s').enabled() or
    get_option('sphincs_shake_192f').enabled() or
    get_option('sphincs_shake_128s').enabled() or
    get_option('sphincs_shake_128f').enabled() or
    get_option('slh_dsa_ascon_128s').enabled() or
    get_option('slh_dsa_ascon_128f').enabled())
	add_global_arguments(['-DLC_SPHINCS'], language: 'c')
	sphincs_enabled = true
endif

if get_option('sphincs_shake_256s').enabled()
	add_global_arguments(['-DLC_SPHINCS_SHAKE_256S_OPT_ENABLED'], language: 'c')
endif
if get_option('sphincs_shake_256f').enabled()
	add_global_arguments(['-DLC_SPHINCS_SHAKE_256F_OPT_ENABLED'], language: 'c')
endif
if get_option('sphincs_shake_192s').enabled()
	add_global_arguments(['-DLC_SPHINCS_SHAKE_192S_OPT_ENABLED'], language: 'c')
endif
if get_option('sphincs_shake_192f').enabled()
	add_global_arguments(['-DLC_SPHINCS_SHAKE_192F_OPT_ENABLED'], language: 'c')
endif
if get_option('sphincs_shake_128s').enabled()
	add_global_arguments(['-DLC_SPHINCS_SHAKE_128S_OPT_ENABLED'], language: 'c')
endif
if get_option('sphincs_shake_128f').enabled()
	add_global_arguments(['-DLC_SPHINCS_SHAKE_128F_OPT_ENABLED'], language: 'c')
endif

if get_option('kyber_x25519').enabled()
	add_global_arguments(['-DLC_CURVE25519'], language: 'c')
endif
if get_option('dilithium_ed25519').enabled()
	add_global_arguments(['-DLC_DILITHIUM_ED25519'], language: 'c')
endif
if get_option('kyber_x448').enabled()
	add_global_arguments(['-DLC_CURVE448'], language: 'c')
endif
if get_option('dilithium_ed448').enabled()
	add_global_arguments(['-DLC_DILITHIUM_ED448'], language: 'c')
endif

if (get_option('bike_5').enabled() or
    get_option('bike_3').enabled() or
    get_option('bike_1').enabled())
	add_global_arguments(['-DLC_BIKE'], language: 'c')
endif

if (get_option('hqc_256').enabled() or
    get_option('hqc_192').enabled() or
    get_option('hqc_128').enabled())
	add_global_arguments(['-DLC_HQC'], language: 'c')
endif

if (get_option('aes_cbc').enabled() or
    get_option('aes_ctr').enabled() or
    get_option('aes_kw').enabled() or
    get_option('aes_xts').enabled() or
    get_option('aes_gcm').enabled())
	add_global_arguments(['-DLC_AES'], language: 'c')
endif
if get_option('aes_cbc').enabled()
	add_global_arguments(['-DLC_AES_CBC'], language: 'c')
endif
if get_option('aes_ctr').enabled()
	add_global_arguments(['-DLC_AES_CTR'], language: 'c')
endif
if get_option('aes_kw').enabled()
	add_global_arguments(['-DLC_AES_KW'], language: 'c')
endif
if get_option('aes_xts').enabled()
	add_global_arguments(['-DLC_AES_XTS'], language: 'c')
endif
if get_option('aes_gcm').enabled()
	add_global_arguments(['-DLC_AES_GCM'], language: 'c')
endif

if get_option('chacha20_drng').enabled()
	add_global_arguments(['-DLC_DRNG_CC20'], language: 'c')
endif
if get_option('kmac_drng').enabled()
	add_global_arguments(['-DLC_DRNG_KMAC'], language: 'c')
endif
if get_option('cshake_drng').enabled()
	add_global_arguments(['-DLC_DRNG_CSHAKE'], language: 'c')
endif
if (get_option('xdrbg').enabled() and get_option('ascon').enabled())
	add_global_arguments(['-DLC_DRNG_XDRBG128'], language: 'c')
endif
if (get_option('xdrbg').enabled() and get_option('sha3').enabled())
	add_global_arguments(['-DLC_DRNG_XDRBG256'], language: 'c')
	add_global_arguments(['-DLC_DRNG_XDRBG512'], language: 'c')
endif
if get_option('drbg_hash').enabled()
	add_global_arguments(['-DLC_DRNG_HASH_DRBG'], language: 'c')
endif
if get_option('drbg_hmac').enabled()
	add_global_arguments(['-DLC_DRNG_HMAC_DRBG'], language: 'c')
endif
if get_option('hkdf').enabled()
	add_global_arguments(['-DLC_HKDF'], language: 'c')
endif
if get_option('kdf_ctr').enabled()
	add_global_arguments(['-DLC_KDF_CTR'], language: 'c')
endif
if get_option('kdf_fb').enabled()
	add_global_arguments(['-DLC_KDF_FB'], language: 'c')
endif
if get_option('kdf_dpi').enabled()
	add_global_arguments(['-DLC_KDF_DPI'], language: 'c')
endif
if get_option('pbkdf2').enabled()
	add_global_arguments(['-DLC_DRNG_PBKDF2'], language: 'c')
endif

aead_support_enabled = false
if (get_option('hash_crypt').enabled() or
    get_option('ascon').enabled() or
    get_option('ascon_keccak').enabled() or
    get_option('chacha20poly1305').enabled() or
    ((get_option('aes_cbc').enabled() or get_option('aes_ctr').enabled()) and
     (get_option('sha2-512').enabled() or get_option('kmac').enabled())))
	add_global_arguments(['-DLC_AEAD'], language: 'c')
	aead_support_enabled = true
endif

if get_option('hash_crypt').enabled()
	add_global_arguments(['-DLC_HASH_CRYPT'], language: 'c')
endif
if get_option('x509_generator').enabled()
	add_global_arguments(['-DLC_X509_GENERATOR'], language: 'c')
endif

# WASM: no Linux secure execution
secure_execution_linux = false

if get_option('timecop').enabled()
	add_global_arguments(['-DLC_USE_TIMECOP'], language: 'c')
endif
if get_option('pkcs7_debug').enabled()
	add_global_arguments(['-DLC_PKCS7_DEBUG'], language: 'c')
endif

# WASM is always a static build
add_global_arguments(['-DLC_STATIC'], language: 'c')
build_shared = false

# WASM: FIPS 140 ELF integrity checker requires a Linux shared library — disabled
fips_integrity_test_enabled = false

# Versioning
version_array = meson.project_version().split('.')
add_global_arguments([
		'-DMAJVERSION=' + version_array[0],
		'-DMINVERSION=' + version_array[1],
		'-DPATCHLEVEL=' + version_array[2],
		'-DVERSION="' + meson.project_version() + '"',
	],
	language: 'c')

# WASM is always little-endian
add_global_arguments(['-DLC_LITTLE_ENDIAN'], language: 'c')

# 64-bit time (no Y2038 problem even in WASM for forward compat)
add_global_arguments(['-D_TIME_BITS=64'], language: 'c')

if get_option('fips140_negative').enabled()
	add_global_arguments(['-DLC_FIPS140_DEBUG'], language: 'c')
	fips140_negative_expect_fail = true
else
	fips140_negative_expect_fail = false
endif

################################################################################
# WASM: assembler always disabled
# All asm variables forced false — subdirs check these before adding asm sources
################################################################################

x86_64_asm       = false
arm32_neon_asm   = false
arm64_neon_gcc_asm = false
arm64_asm        = false
riscv32_asm      = false
riscv64_asm      = false
riscv32_gcc_asm  = false
riscv64_gcc_asm  = false

################################################################################
# Dependency validation (identical to meson.build)
################################################################################

if (get_option('drbg_hmac').enabled() and
    (get_option('sha2-512').disabled() or get_option('hmac').disabled()))
	error('HMAC DRBG requires SHA2-512 and HMAC')
endif

if get_option('drbg_hash').enabled() and get_option('sha2-512').disabled()
	error('HMAC DRBG requires SHA2-512')
endif

if get_option('hmac').enabled()
	if get_option('sha2-256').disabled() and get_option('sha2-512').disabled()
		error('HMAC requires SHA2-256 or SHA2-512 support')
	endif
endif

if get_option('hash_crypt').enabled()
	if get_option('drbg_hash').disabled()
		error('Hash Crypt support requires Hash DRBG SHA2-512 support')
	endif
	if get_option('hmac').disabled()
		error('Hash Crypt support requires HMAC support')
	endif
endif

if get_option('kmac').enabled()
	if get_option('sha3').disabled()
		error('KMAC support requires SHA-3 support')
	endif
endif

if (get_option('sha2-256').disabled() and
   (get_option('hkdf').enabled() or get_option('kdf_ctr').enabled() or
    get_option('kdf_fb').enabled() or get_option('kdf_dpi').enabled() or
    get_option('pbkdf2').enabled()))
	error('KDF support requires SHA2-256')
endif

if get_option('sha2-256').disabled() and get_option('hotp').enabled()
	error('HOTP support requires SHA2-256')
endif

if get_option('hmac').disabled() and get_option('hotp').enabled()
	error('HOTP support requires HMAC')
endif

if get_option('hotp').disabled() and get_option('totp').enabled()
	error('TOTP support requires HOTP support')
endif

if get_option('chacha20_drng').enabled() and get_option('chacha20').disabled()
	error('ChaCha20 DRNG requires ChaCha20 support')
endif

if (get_option('sha3').disabled() and
    (get_option('dilithium_87').enabled() or
     get_option('dilithium_65').enabled() or
     get_option('dilithium_44').enabled()))
	error('Dilithium support requires SHA-3')
endif

if (get_option('kmac').disabled() and
    (get_option('kyber_1024').enabled() or
     get_option('kyber_768').enabled() or
     get_option('kyber_512').enabled()))
	error('Kyber support requires KMAC due to SP800-108 KDF')
endif

if (get_option('sha3').disabled() and
    (get_option('sphincs_shake_256s').enabled() or
     get_option('sphincs_shake_256f').enabled() or
     get_option('sphincs_shake_192s').enabled() or
     get_option('sphincs_shake_192f').enabled() or
     get_option('sphincs_shake_128s').enabled() or
     get_option('sphincs_shake_128f').enabled()))
	error('Sphincs Plus support requires SHA-3')
endif

if (get_option('sha3').disabled() and
    (get_option('kyber_1024').enabled() or
     get_option('kyber_768').enabled() or
     get_option('kyber_512').enabled()))
	error('Kyber support requires SHA-3')
endif

if (get_option('sha3').disabled() and
    (get_option('bike_5').enabled() or
     get_option('bike_3').enabled() or
     get_option('bike_1').enabled()))
	error('BIKE support requires SHA-3')
endif

if (get_option('sha3').disabled() and
    (get_option('hqc_256').enabled() or
     get_option('hqc_192').enabled() or
     get_option('hqc_128').enabled()))
	error('HQC support requires SHA-3')
endif

if ((get_option('dilithium_ed25519').enabled() or
     get_option('kyber_x25519').enabled()) and
     get_option('sha2-512').disabled())
	error('Curve 25519 support requires SHA2-512')
endif

if get_option('sha3').disabled() and get_option('ascon_keccak').enabled()
	error('Ascon-Keccak support requires SHA-3')
endif

if (get_option('slh_dsa_ascon_128s').enabled() and
    get_option('ascon').disabled())
	error('SLH-DSA-Ascon-128s support requires Ascon')
endif

if (get_option('slh_dsa_ascon_128f').enabled() and
    get_option('ascon').disabled())
	error('SLH-DSA-Ascon-128f support requires Ascon')
endif

if get_option('x509_parser').disabled() and get_option('pkcs7_parser').enabled()
	error('PKCS#7 parser support requires X.509 parser support')
endif

if get_option('x509_parser').disabled() and get_option('x509_generator').enabled()
	error('X.509 generator support requires X.509 parser support')
endif

if get_option('pkcs7_parser').disabled() and get_option('pkcs7_generator').enabled()
	error('PKCS#7 / CMS generator support requires PKCS#7 / CMS parser support')
endif

if (get_option('chacha20poly1305').enabled() and
    get_option('chacha20').disabled())
	error('ChaCha20 Poly 1305 requires the presence of ChaCha20')
endif

################################################################################
# Project-specific defines
################################################################################

pkgconfig = import('pkgconfig')

include_dirs = include_directories([
			'aead/api',
			'apps/api',
			'asn1/src',
			'bike/api',
			'curve25519/api',
			'curve448/api',
			'drng/api',
			'drng/src',
			'hash/api',
			'hmac/api',
			'hqc/api',
			'ml-kem/api',
			'ml-kem/src',
			'kdf/api',
			'kmac/api',
			'otp/api',
			'ml-dsa/api',
			'slh-dsa/api',
			'sym/api',
			'asn1/api',
		])

include_files = []

include_internal_dirs = include_directories(['internal/api'])

subdirs = [
	    # These must be first to generate the header files
	    'internal/api',
	    'hash/api',

	    'aead/src',
	    'bike/api',
	    'bike/src',
	    'curve25519/src',
	    'curve448/src',
	    'drng/src',
	    'hash/src',
	    'hqc/api',
	    'hqc/src',
	    'internal/src',
	    'kdf/src',
	    'ml-kem/api',
	    'ml-kem/src',
	    'otp/src',
	    'ml-dsa/api',
	    'ml-dsa/src',
	    'slh-dsa/api',
	    'slh-dsa/src',
	    'sym/src',
	    'asn1/src',
	    # 'efi/src' — EFI not supported in WASM
	  ]

testdirs = [
	     'apps/tests',
	     'aead/tests',
	     'bike/tests',
	     'curve25519/tests',
	     'curve448/tests',
	     'drng/tests',
	     'hash/tests',
	     'hqc/tests',
	     'internal/tests',
	     'kdf/tests',
	     'ml-kem/tests',
	     'otp/tests',
	     'ml-dsa/tests',
	     'slh-dsa/tests',
	     'sym/tests',
	     'asn1/tests',
	     # 'efi/tests' — EFI not supported in WASM
	   ]

if get_option('hmac').enabled()
	subdirs += 'hmac/src'
	testdirs += 'hmac/tests'
endif

if get_option('kmac').enabled()
	subdirs += 'kmac/src'
	testdirs += 'kmac/tests'
endif

# Header generation script
header_script = find_program('addon/generate_header.sh', required: true)

# Prepare distribution
dist_script = find_program('addon/sanity_checks.sh', required: true)
meson.add_dist_script(dist_script, meson.project_version())

# Find Doxygen program
doxygen = find_program('doxygen', required: false)

################################################################################
# Execute compilation
################################################################################

src             = []
src_fips_wrapper = []
src_wrapper     = []
internal_src    = []
leancrypto_support_libs = []
leancrypto_link = []

foreach n : subdirs
	subdir(n)
endforeach

# Generate leancrypto.h
autogen_header = meson.project_build_root() + '/leancrypto.h'
leancrypto_header_subdir = 'leancrypto'

run_command(header_script,
	    autogen_header,
	    leancrypto_header_subdir,
	    include_files,
	    check: true)

################################################################################
# Build — static libraries only (WASM does not use ELF shared objects)
################################################################################

fips_integrity_hasher_dep = []

leancrypto_raw_static_lib = static_library('leancrypto-raw',
	[src, internal_src],
	include_directories: [include_dirs, include_internal_dirs],
	dependencies: [leancrypto_link],
	link_whole: [leancrypto_support_libs],
	install: true
	)

leancrypto_static_lib = static_library('leancrypto',
	[src_wrapper],
	include_directories: [include_dirs, include_internal_dirs],
	dependencies: [leancrypto_link],
	link_whole: [leancrypto_raw_static_lib],
	install: true
	)
leancrypto_lib = leancrypto_static_lib

leancrypto_static_lib_fips = static_library('leancrypto-fips',
	[src_fips_wrapper],
	include_directories: [include_dirs, include_internal_dirs],
	dependencies: [leancrypto_link],
	link_whole: [leancrypto_raw_static_lib],
	install: true
	)
leancrypto_lib_fips = leancrypto_static_lib_fips

pkgconfig.generate(leancrypto_lib_fips,
		   description: 'PQC-resistant cryptographic library with FIPS 140 compliance (WASM)')

leancrypto_fips = declare_dependency(link_with: leancrypto_lib_fips,
				     include_directories: include_dirs)

pkgconfig.generate(leancrypto_lib,
		   description: 'PQC-resistant cryptographic library (WASM)')

leancrypto = declare_dependency(link_with: leancrypto_lib,
				include_directories: include_dirs)

install_headers(include_files, subdir: leancrypto_header_subdir)
install_headers(autogen_header)

################################################################################
# Doxygen (optional)
################################################################################

if doxygen.found()
	subdir('doc')
else
	message('Doxygen documentation not generated due to missing Doxygen binary')
endif

################################################################################
# Tests (skip by default for WASM; enable with -Dtests=enabled)
# Note: running WASM test binaries requires node or a WASM runtime.
#       emcc compiles test executables to .js + .wasm pairs runnable via node.
################################################################################

performance = 'performance'
regression  = 'regression'

if get_option('tests').enabled()
	foreach n : testdirs
		subdir(n)
	endforeach
endif
