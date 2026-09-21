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

class SamlValidator {
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
			// 1. Syntax check
			const syntax = this.validateSyntax(xmlInput);
			results.push(...syntax.results);
			if (syntax.stop) return results; // stop on syntax error

			const xmlDoc = syntax.xmlDoc;

			// 2. Namespace validation
			const nsResults = this.validateNamespaces(xmlDoc);
			results.push(...nsResults);

			// Ensure required namespaces are present for remainder of tests (e.g. XPath evaluation)
			this.ensureNamespaces(xmlDoc);

			// 3. XSD validation
			const xsdResults = await this.validateAgainstXsd(xmlInput);
			results.push(...xsdResults);

			// 4. Signature verification
			const sigResults = await this.verifyXmlSignature(xmlDoc);
			results.push(...sigResults);

			// 5. Custom checks
			const customResults = this.runCustomChecks(xmlDoc);
			results.push(...customResults);

		} catch (e) {
			results.push({type: 'error', message: 'Unexpected Error: ' + e.message});
		}

		return results;
	}

	// 1) XML Syntax validation, produce xmlDoc for subsequent steps
	validateSyntax(xmlInput) {
		const out = {results: [], stop: false, xmlDoc: null};
		const parser = new window.DOMParser();
		const xmlDoc = parser.parseFromString(xmlInput, 'text/xml');
		const parseError = xmlDoc.getElementsByTagName('parsererror');
		if (parseError.length > 0) {
			out.results.push({type: 'error', message: 'XML Syntax Error: ' + parseError[0].textContent});
			out.stop = true;
			return out;
		}
		out.results.push({type: 'success', message: 'XML Syntax is valid.'});
		out.xmlDoc = xmlDoc;
		return out;
	}

	// 2) Namespace validation
	validateNamespaces(xmlDoc) {
		const results = [];
		const requiredNamespaces = {
			'md': 'urn:oasis:names:tc:SAML:2.0:metadata',
			'mdui': 'urn:oasis:names:tc:SAML:metadata:ui',
			'ds': 'http://www.w3.org/2000/09/xmldsig#'
		};

		const docElement = xmlDoc.documentElement;
		if (!docElement) {
			results.push({type: 'error', message: 'Document root element missing.'});
			return results;
		}

		for (const [prefix, expectedUri] of Object.entries(requiredNamespaces)) {
			const attr = docElement.getAttributeNode(`xmlns:${prefix}`);
			if (!attr) {
				results.push({
					type: 'error', message: `Missing required namespace: xmlns:${prefix}="${expectedUri}"`
				});
			} else if (attr.value !== expectedUri) {
				results.push({
					type: 'error',
					message: `Incorrect namespace URI for xmlns:${prefix}: expected "${expectedUri}", got "${attr.value}"`
				});
			} else {
				results.push({
					type: 'success', message: `Namespace defined: xmlns:${prefix}="${expectedUri}"`
				});
			}
		}
		return results;
	}

	ensureNamespaces(xmlDoc) {
		const requiredNamespaces = {
			'xml': 'http://www.w3.org/XML/1998/namespace',
			'md': 'urn:oasis:names:tc:SAML:2.0:metadata',
			'mdui': 'urn:oasis:names:tc:SAML:metadata:ui',
			'ds': 'http://www.w3.org/2000/09/xmldsig#'
		};
		const docElement = xmlDoc.documentElement;
		if (!docElement) return;

		for (const [prefix, expectedUri] of Object.entries(requiredNamespaces)) {
			const attr = docElement.getAttributeNode(`xmlns:${prefix}`);
			if (!attr) {
				docElement.setAttribute(`xmlns:${prefix}`, expectedUri);
			}
		}
	}

	// 2) XSD validation using xmllint-wasm
	async validateAgainstXsd(xmlInput) {
		const results = [];
		try {
			const supportsModuleWorkers = () => {
				try {
					const blob = new Blob(['export default 42;'], {type: 'application/javascript'});
					const url = URL.createObjectURL(blob);
					const w = new Worker(url, {type: 'module'});
					w.terminate();
					URL.revokeObjectURL(url);
					return true;
				} catch {
					return false;
				}
			};

			if (!supportsModuleWorkers()) {
				results.push({
					type: 'error',
					message: 'XSD validation is not available: this browser/session does not support Module Workers.' + ' Try a Chromium-based browser or open the production build (dist/index.html).'
				});
				return results;
			}

			// Helper function to fetch and validate schema files (expression form for JSHint compliance)
			const fetchSchemaFile = async (schemaPath) => {
				const res = await fetch(`schemas/${schemaPath}`);
				if (!res.ok) {
					throw new Error(`Failed to load schema: schemas/${schemaPath} (HTTP ${res.status})`);
				}
				const contentType = res.headers.get('content-type');
				if (!contentType || !contentType.includes('xml')) {
					throw new Error(`Invalid content-type for schema: schemas/${schemaPath}
					(expected xsd, got ${contentType})`);
				}
				return await res.text();
			};

			// Then use it in the code block:
			const mainSchemaObject = await fetchSchemaFile(MAIN_SCHEMA);

			const schemaObjects = await Promise.all(Object.entries(SCHEMAS).map(async ([namespace, file]) => {
				const contents = await fetchSchemaFile(file);
				return {fileName: namespace, contents};
			}));
			const validation = await validateXML({
				xml: [{fileName: 'metadata.xml', contents: xmlInput}], schema: mainSchemaObject, preload: schemaObjects,
			});
			if (validation.errors && validation.errors.length > 0) {
				validation.errors.forEach(err => {
					const loc = err.loc ? err.loc.lineNumber : 'unknown';
					results.push({type: 'error', message: `XSD Error: ${err.message} (Line ${loc})`});
				});
			} else {
				results.push({type: 'success', message: 'XML passes SAML 2.0 Metadata XSD validation.'});
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
				} catch {
					errMsg = String(xsdError);
				}
			}
			if (xsdError && xsdError.stack) {
				errMsg += `\n${xsdError.stack}`;
			}
			results.push({type: 'error', message: 'XSD Validation initialization failed: ' + errMsg});
		}
		return results;
	}

	// 3) XML Signature verification using xmldsigjs
	async verifyXmlSignature(xmlDoc) {
		const results = [];
		try {
			const dsNs = 'http://www.w3.org/2000/09/xmldsig#';
			const signatureEl = xmlDoc.getElementsByTagNameNS(dsNs, 'Signature')[0];
			if (!signatureEl) {
				results.push({type: 'info', message: 'XML Signature: No ds:Signature element found.'});
				return results;
			}

			let xmldsig;
			try {
				xmldsig = await import('xmldsigjs');
			} catch {
				results.push({
					type: 'error',
					message: 'XML Signature verification library not available. ' + 'Please install dependency: npm install xmldsigjs',
					help: 'Install xmldsigjs and rebuild to enable cryptographic signature verification.'
				});
				return results; // cannot proceed further
			}

			try {
				if (xmldsig.Application && xmldsig.CryptoEngine && xmldsig.Crypto) {
					xmldsig.Application.setEngine('WebCrypto', new xmldsig.CryptoEngine({
						name: 'WebCrypto', crypto: window.crypto, subtle: window.crypto && window.crypto.subtle
					}, new xmldsig.Crypto()));
				}
			} catch { /* best-effort */
				void 0;
			}

			const SignedXml = (xmldsig.SignedXml || xmldsig.SignedXmlDocument || (xmldsig.default && xmldsig.default.SignedXml));
			if (!SignedXml) {
				results.push({
					type: 'error', message: 'XML Signature: xmldsigjs SignedXml class not found (version mismatch).'
				});
				return results;
			}

			try {
				const signedXml = new SignedXml(xmlDoc);
				if (typeof signedXml.LoadXml === 'function') {
					signedXml.LoadXml(signatureEl);
				}
				let verified = false;
				if (typeof signedXml.Verify === 'function') {
					verified = await signedXml.Verify();
				} else if (typeof signedXml.verify === 'function') {
					verified = await signedXml.verify();
				}

				let sigMethod = null;
				const sigMethodEl = signatureEl.getElementsByTagNameNS(dsNs, 'SignatureMethod')[0];
				if (sigMethodEl) sigMethod = sigMethodEl.getAttribute('Algorithm');

				if (verified) {
					results.push({
						type: 'success',
						message: `XML Signature verified successfully${sigMethod ? ` (${sigMethod})` : ''}.`
					});
				} else {
					let details = '';
					if (signedXml.validationResult) {
						try {
							details = JSON.stringify(signedXml.validationResult);
						} catch {
							void 0;
						}
					}
					results.push({
						type: 'error',
						message: `XML Signature verification failed${sigMethod ? ` (${sigMethod})` : ''}. ${details}`
					});
				}
			} catch (sigErr) {
				let err = '';
				try {
					err = sigErr?.message || JSON.stringify(sigErr);
				} catch {
					err = String(sigErr);
				}
				results.push({type: 'error', message: 'XML Signature verification error: ' + err});
			}
		} catch {
			// ignore, results already collected as much as possible
			void 0;
		}
		return results;
	}

	// 4) Custom XPath-based checks defined via config
	runCustomChecks(xmlDoc) {
		const results = [];
		const nsResolver = (prefix) => {
			if (!prefix) return null;
			const docElement = xmlDoc.documentElement;
			if (!docElement) return null;
			const nsAttr = docElement.getAttributeNode(`xmlns:${prefix}`);
			if (nsAttr) return nsAttr.value;
			const defaultNs = docElement.getAttributeNode('xmlns');
			if (defaultNs && prefix === 'default') return defaultNs.value;
			return null;
		};

		this.config.forEach(check => {
			const maxOccurrences = check['occurence-max'] !== undefined ? check['occurence-max'] : check['occurrence-max'];
			const childrenRequired = check['children-required'];
			const regexpMatch = check['regexp-match'];

			if (childrenRequired !== undefined) {
				const snapshot = xmlDoc.evaluate(check.xpath, xmlDoc, nsResolver, window.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
				const count = snapshot.snapshotLength;
				if (count === 0) {
					results.push({type: 'error', message: `Missing: ${check.label}`, help: check.help});
				} else {
					for (let i = 0; i < count; i++) {
						const node = snapshot.snapshotItem(i);
						for (const childSpec of childrenRequired) {
							const rawTag = childSpec.replace(/^<|>$/g, '');
							let nsUri = null;
							let localName = rawTag;
							if (rawTag.includes(':')) {
								const parts = rawTag.split(':');
								nsUri = nsResolver(parts[0]);
								localName = parts[1];
							}
							const found = nsUri ? node.getElementsByTagNameNS(nsUri, localName) : node.getElementsByTagName(localName);
							if (found.length === 0) {
								results.push({
									type: 'error',
									message: `Missing child: ${childSpec} for ${check.label}`,
									help: check.help
								});
							} else {
								results.push({
									type: 'success', message: `Present child: ${childSpec} for ${check.label}`
								});
							}
						}
					}
				}
			} else if (regexpMatch !== undefined) {
				const snapshot = xmlDoc.evaluate(check.xpath, xmlDoc, nsResolver, window.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
				const count = snapshot.snapshotLength;
				if (count === 0) {
					results.push({type: 'error', message: `Missing: ${check.label}`, help: check.help});
				} else {
					const regex = new RegExp(regexpMatch);
					for (let i = 0; i < count; i++) {
						const node = snapshot.snapshotItem(i);
						const text = node.textContent || '';
						if (regex.test(text)) {
							results.push({type: 'success', message: `Present: ${check.label}`});
						} else {
							results.push({type: 'error', message: `Invalid format: ${check.label}`, help: check.help});
						}
					}
				}
			} else if (maxOccurrences !== undefined) {
				const snapshot = xmlDoc.evaluate(check.xpath, xmlDoc, nsResolver, window.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
				const count = snapshot.snapshotLength;
				if (count === 0) {
					results.push({type: 'error', message: `Missing: ${check.label}`, help: check.help});
				} else if (count > maxOccurrences) {
					results.push({
						type: 'error',
						message: `Too many: ${check.label} (found ${count}, maximum allowed ${maxOccurrences})`,
						help: check.help
					});
				} else {
					results.push({type: 'success', message: `Present: ${check.label}`});
				}
			} else {
				const result = xmlDoc.evaluate(check.xpath, xmlDoc, nsResolver, window.XPathResult.BOOLEAN_TYPE, null);
				if (result.booleanValue) {
					results.push({type: 'success', message: `Present: ${check.label}`});
				} else {
					results.push({type: 'error', message: `Missing: ${check.label}`, help: check.help});
				}
			}
		});
		return results;
	}
}

export default SamlValidator;
