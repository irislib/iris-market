// Node module hooks: compile Svelte components for tests and give Svelte (only) its browser build.
import {readFile} from 'node:fs/promises'
import {stripTypeScriptTypes} from 'node:module'
import {fileURLToPath} from 'node:url'
import {compile, compileModule} from 'svelte/compiler'

const svelteCode = (specifier, parentURL = '') =>
  specifier === 'svelte' || specifier.startsWith('svelte/') || specifier === 'esm-env' || parentURL.includes('/node_modules/svelte/') || parentURL.includes('/node_modules/esm-env/')

export async function resolve(specifier, context, next) {
  if (!svelteCode(specifier, context.parentURL)) return next(specifier, context)
  return next(specifier, {...context, conditions: ['browser', ...context.conditions]})
}

export async function load(url, context, next) {
  if (!/\.svelte(?:\.[jt]s)?$/.test(url)) return next(url, context)
  const filename = fileURLToPath(url)
  const source = await readFile(filename, 'utf8')
  const options = {filename, generate: 'client', dev: false}
  const {js} = url.endsWith('.svelte')
    ? compile(source, options)
    : compileModule(url.endsWith('.ts') ? stripTypeScriptTypes(source) : source, options)
  return {format: 'module', source: js.code, shortCircuit: true}
}
