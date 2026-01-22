import {validateXML} from 'xmllint-wasm';

const MAIN_SCHEMA = "saml.xsd";

const SCHEMAS = {
	"xmldsig-core-schema.xsd": "xmldsig-core-schema.xsd",
	"xenc-schema.xsd": "xenc-schema.xsd",
	"xml.xsd": "xml.xsd",
	"saml-schema-metadata-2.0.xsd": "saml-schema-metadata-2.0.xsd",
	"saml-schema-assertion-2.0.xsd": "saml-schema-assertion-2.0.xsd",
	"saml-schema-protocol-2.0.xsd": "saml-schema-protocol-2.0.xsd",
	"sstc-saml-metadata-ui-v1.0.xsd": "sstc-saml-metadata-ui-v1.0.xsd",
};

export class SamlValidator {
	constructor(config = []) {
		this.config = Array.isArray(config) ? config : [];
	}

	setConfig(config) {
		this.config = config;
	}

	async initialize() {
		// xmllint-wasm 5.x validateXML creates a worker on each call, no global initialization needed
		return true;
	}

	async validate(xmlInput) {
		const results = [];
		if (!xmlInput.trim()) return results;

		try {
				// 1. Syntax Check (Browser DOMParser)
				const parser = new window.DOMParser();
				const xmlDoc = parser.parseFromString(xmlInput, "text/xml");
				const parseError = xmlDoc.getElementsByTagName("parsererror");

				if (parseError.length > 0) {
					results.push({
						type: 'error',
						message: 'XML Syntax Error: ' + parseError[0].textContent
					});
					return results;
				}
				results.push({type: 'success', message: 'XML Syntax is valid.'});

			// 2. XSD Validation (via xmllint-wasm)
			try {
				// Quick capability check: xmllint-wasm relies on module Workers in the browser
				const supportsModuleWorkers = () => {
					try {
						// Some browsers (notably Firefox without bundling) don't support module workers in dev
						// We attempt to construct a dummy module worker to detect support
						const blob = new Blob(["export default 42;"], {type: 'application/javascript'});
						const url = URL.createObjectURL(blob);
						const w = new Worker(url, {type: 'module'});
						w.terminate();
						URL.revokeObjectURL(url);
						return true;
					} catch (e) {
						return false;
					}
				};

				if (!supportsModuleWorkers()) {
					results.push({
						type: 'error',
						message: 'XSD validation is not available: this browser/session does not support Module Workers required by xmllint-wasm. Try a Chromium-based browser or open the production build (dist/index.html).'
					});
					return results;
				}

				const res = await fetch(`schemas/${MAIN_SCHEMA}`);
				if (!res.ok) throw new Error(`Failed to load catalog: schemas/${MAIN_SCHEMA} (HTTP ${res.status})`);
				const contentType = res.headers.get('content-type');
				if (!contentType || !contentType.includes('xml')) {
					throw new Error(`Invalid content-type for schema: schemas/${MAIN_SCHEMA} (expected xsd, got ${contentType})`);
				}
				const mainSchemaObject = await res.text();

				// Load schemas with their system IDs so imports resolve
				const schemaObjects = await Promise.all(
					Object.entries(SCHEMAS).map(async ([namespace, file]) => {
						const res = await fetch(`schemas/${file}`);
						if (!res.ok) throw new Error(`Failed to load schema: schemas/${file} (HTTP ${res.status})`);
						const contentType = res.headers.get('content-type');
						if (!contentType || !contentType.includes('xml')) {
							throw new Error(`Invalid content-type for schema: schemas/${file} (expected xsd, got ${contentType})`);
						}
						const contents = await res.text();
						return {fileName: namespace, contents: contents};
					})
				);

				const validation = await validateXML({
					xml: [{fileName: 'metadata.xml', contents: xmlInput}],
					schema: mainSchemaObject,
					preload: schemaObjects,
				});
				if (validation.errors && validation.errors.length > 0) {
					validation.errors.forEach(err => {
						const loc = err.loc ? err.loc.lineNumber : 'unknown';
						results.push({
							type: 'error',
							message: `XSD Error: ${err.message} (Line ${loc})`
						});
					});
				} else {
					results.push({
						type: 'success',
						message: 'XML passes SAML 2.0 Metadata XSD validation.'
					});
				}
			} catch (xsdError) {
				let errMsg = '';
				if (xsdError && xsdError.message) {
					errMsg = xsdError.message;
				} else if (xsdError && xsdError.type) {
					errMsg = `${xsdError.type}`;
				} else {
					try {
						errMsg = JSON.stringify(xsdError);
					} catch (_) {
						errMsg = String(xsdError);
					}
				}
				if (xsdError && xsdError.stack) {
					errMsg += `\n${xsdError.stack}`;
				}
				results.push({type: 'error', message: 'XSD Validation initialization failed: ' + errMsg});
			}

			// 3. Custom Tag Checks
			// Build namespace resolver from the document itself
			const nsResolver = (prefix) => {
				if (!prefix) return null;

				// First check the document element for xmlns attributes
				const docElement = xmlDoc.documentElement;
				if (!docElement) return null;

				// Look for xmlns:prefix="uri" attribute
				const nsAttr = docElement.getAttributeNode(`xmlns:${prefix}`);
				if (nsAttr) return nsAttr.value;

				// Check for default namespace if prefix is requested
				const defaultNs = docElement.getAttributeNode('xmlns');
				if (defaultNs && prefix === 'default') return defaultNs.value;

				return null;
			};

			this.config.forEach(check => {
				const result = xmlDoc.evaluate(check.xpath, xmlDoc, nsResolver, window.XPathResult.BOOLEAN_TYPE, null);
				if (result.booleanValue) {
					results.push({type: 'success', message: `Present: ${check.label}`});
				} else {
					results.push({
						type: 'error',
						message: `Missing: ${check.label}`,
						help: check.help
					});
				}
			});

		} catch (e) {
			results.push({type: 'error', message: 'Unexpected Error: ' + e.message});
		}

		return results;
	}
}
