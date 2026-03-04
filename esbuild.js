const esbuild = require("esbuild");
const path = require("path");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

/**
 * Resolve @monoid/analyzer-core path aliases to local source
 * @type {import('esbuild').Plugin}
 */
const analyzerCoreAliasPlugin = {
	name: 'analyzer-core-alias',
	setup(build) {
		// @monoid/analyzer-core -> packages/analyzer-core/src/index.ts
		build.onResolve({ filter: /^@monoid\/analyzer-core$/ }, () => ({
			path: path.resolve(__dirname, 'packages/analyzer-core/src/index.ts'),
		}));
		// @monoid/analyzer-core/types -> packages/analyzer-core/src/types.ts
		build.onResolve({ filter: /^@monoid\/analyzer-core\/(.+)$/ }, (args) => {
			const subpath = args.path.replace('@monoid/analyzer-core/', '');
			return {
				path: path.resolve(__dirname, 'packages/analyzer-core/src', subpath + '.ts'),
			};
		});
	},
};

async function main() {
	const ctx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			analyzerCoreAliasPlugin,
			esbuildProblemMatcherPlugin,
		],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
