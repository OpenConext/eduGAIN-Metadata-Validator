import {beforeEach, describe, expect, it, vi} from 'vitest';
import SamlValidator from './validator.js';
import {validateXML} from 'xmllint-wasm';

/* jshint node: true */

vi.mock('xmllint-wasm', () => ({
	validateXML: vi.fn(),
}));

let mockMissingSignedXml = false;
let mockLowercaseVerify = false;

class MockSignedXml {
	constructor(xmlDoc) {
		this.xmlDoc = xmlDoc;
		this.validationResult = {error: 'invalid'};
	}

	LoadXml(sigEl) {
		if (sigEl && sigEl.getAttribute) {
			if (sigEl.getAttribute('throw') === 'true') {
				this._shouldThrow = true;
			}
			if (sigEl.getAttribute('circular-err') === 'true') {
				this._circularErr = true;
			}
			if (sigEl.getAttribute('verify-true') === 'true') {
				this._verifyTrue = true;
			}
		}
	}

	async Verify() {
		if (this._shouldThrow) {
			throw new Error('raw string sig error');
		}
		if (this._circularErr) {
			const err = {};
			err.self = err;
			throw err;
		}
		if (this._verifyTrue) {
			return true;
		}
		return false;
	}
}

class MockSignedXmlLowercase {
	constructor() {
	}

	LoadXml() {
	}

	async verify() {
		return true;
	}
}

vi.mock('xmldsigjs', () => {
	return {
		Application: {
			setEngine: vi.fn(() => {
				throw new Error('Engine set error');
			}),
		},
		CryptoEngine: class {
		},
		Crypto: class {
		},
		get SignedXml() {
			if (mockMissingSignedXml) return undefined;
			if (mockLowercaseVerify) return MockSignedXmlLowercase;
			return MockSignedXml;
		},
		get SignedXmlDocument() {
			return undefined;
		},
		default: {
			get SignedXml() {
				if (mockMissingSignedXml) return undefined;
				if (mockLowercaseVerify) return MockSignedXmlLowercase;
				return MockSignedXml;
			},
		},
	};
});

describe('SamlValidator', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockMissingSignedXml = false;
		mockLowercaseVerify = false;
		window.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock');
		window.URL.revokeObjectURL = vi.fn();
		window.Worker = class {
			terminate() {
			}
		};
	});

	it('should initialize with default or custom config, including non-array config', () => {
		const validator1 = new SamlValidator();
		expect(validator1.config).toEqual([]);

		const validatorNotArray = new SamlValidator('not-array');
		expect(validatorNotArray.config).toEqual([]);

		const validator2 = new SamlValidator([{xpath: '//test'}]);
		expect(validator2.config).toEqual([{xpath: '//test'}]);

		validator1.setConfig([{xpath: '//other'}]);
		expect(validator1.config).toEqual([{xpath: '//other'}]);
	});

	it('should initialize successfully', async () => {
		const validator = new SamlValidator();
		const res = await validator.initialize();
		expect(res).toBe(true);
	});

	describe('validateSyntax', () => {
		it('should validate correct XML syntax', () => {
			const validator = new SamlValidator();
			const xml = '<root xmlns="urn:oasis:names:tc:SAML:2.0:metadata"></root>';
			const result = validator.validateSyntax(xml);
			expect(result.stop).toBe(false);
			expect(result.xmlDoc).not.toBeNull();
			expect(result.results[0].type).toBe('success');
		});

		it('should catch malformed XML syntax', () => {
			const validator = new SamlValidator();
			const xml = '<root><unclosed></root>';
			const result = validator.validateSyntax(xml);
			expect(result.stop).toBe(true);
			expect(result.results[0].type).toBe('error');
			expect(result.results[0].message).toContain('XML Syntax Error');
		});
	});

	describe('validateNamespaces & ensureNamespaces', () => {
		it('should validate required namespaces correctly and report incorrect/missing URIs', () => {
			const validator = new SamlValidator();
			const parser = new window.DOMParser();
			// missing mdui and incorrect ds URI
			const xmlDoc = parser.parseFromString(
				'<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://wrong"></md:EntityDescriptor>',
				'text/xml'
			);
			const results = validator.validateNamespaces(xmlDoc);
			expect(results.some(r => r.message.includes('Missing required namespace: xmlns:mdui'))).toBe(true);
			expect(results.some(r => r.message.includes('Incorrect namespace URI for xmlns:ds'))).toBe(true);
			expect(results.some(r => r.message.includes('Namespace defined: xmlns:md'))).toBe(true);
		});

		it('should handle document root element missing in validateNamespaces', () => {
			const validator = new SamlValidator();
			const emptyDoc = {documentElement: null};
			const results = validator.validateNamespaces(emptyDoc);
			expect(results).toEqual([{type: 'error', message: 'Document root element missing.'}]);
		});

		it('should ensure missing namespaces are added', () => {
			const validator = new SamlValidator();
			const parser = new window.DOMParser();
			const xmlDoc = parser.parseFromString('<EntityDescriptor></EntityDescriptor>', 'text/xml');
			validator.ensureNamespaces(xmlDoc);
			const root = xmlDoc.documentElement;
			expect(root.getAttribute('xmlns:md')).toBe('urn:oasis:names:tc:SAML:2.0:metadata');
			expect(root.getAttribute('xmlns:xml')).toBe('http://www.w3.org/XML/1998/namespace');
		});

		it('should handle ensureNamespaces with missing documentElement', () => {
			const validator = new SamlValidator();
			expect(() => validator.ensureNamespaces({documentElement: null})).not.toThrow();
		});
	});

	describe('validateAgainstXsd', () => {
		it('should pass XSD validation when no errors are returned', async () => {
			validateXML.mockResolvedValueOnce({errors: []});
			const validator = new SamlValidator();

			global.fetch = vi.fn().mockImplementation(() => {
				return Promise.resolve({
					ok: true,
					headers: {get: () => 'text/xml'},
					text: () => Promise.resolve('<xs:schema></xs:schema>'),
				});
			});

			const results = await validator.validateAgainstXsd('<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"/>');
			expect(results.some(r => r.type === 'success')).toBe(true);
		});

		it('should report XSD errors when validation fails', async () => {
			validateXML.mockResolvedValueOnce({
				errors: [{
					message: 'Invalid element',
					loc: {lineNumber: 10}
				}, {message: 'Another error'}]
			});
			const validator = new SamlValidator();

			global.fetch = vi.fn().mockImplementation(() => {
				return Promise.resolve({
					ok: true,
					headers: {get: () => 'text/xml'},
					text: () => Promise.resolve('<xs:schema></xs:schema>'),
				});
			});

			const results = await validator.validateAgainstXsd('<invalid/>');
			expect(results.some(r => r.message.includes('XSD Error: Invalid element (Line 10)'))).toBe(true);
			expect(results.some(r => r.message.includes('XSD Error: Another error (Line unknown)'))).toBe(true);
		});

		it('should handle schema fetch errors', async () => {
			const validator = new SamlValidator();
			global.fetch = vi.fn().mockResolvedValueOnce({
				ok: false,
				status: 404,
			});

			const results = await validator.validateAgainstXsd('<md:EntityDescriptor/>');
			expect(results.some(r => r.message.includes('XSD Validation initialization failed'))).toBe(true);
		});

		it('should handle schema fetch invalid content-type', async () => {
			const validator = new SamlValidator();
			global.fetch = vi.fn().mockResolvedValueOnce({
				ok: true,
				headers: {get: () => 'text/html'},
			});

			const results = await validator.validateAgainstXsd('<md:EntityDescriptor/>');
			expect(results.some(r => r.message.includes('Invalid content-type'))).toBe(true);
		});

		it('should handle supportsModuleWorkers returning false', async () => {
			window.Worker = undefined;
			const validator = new SamlValidator();
			const results = await validator.validateAgainstXsd('<md:EntityDescriptor/>');
			expect(results.some(r => r.message.includes('XSD validation is not available'))).toBe(true);
		});

		it('should handle various xsdError structures in catch block', async () => {
			const validator = new SamlValidator();
			globalThis.fetch = vi.fn().mockRejectedValueOnce({type: 'NetworkError'});

			let results = await validator.validateAgainstXsd('<md:EntityDescriptor/>');
			expect(results.some(r => r.message.includes('NetworkError'))).toBe(true);

			globalThis.fetch = vi.fn().mockRejectedValueOnce('raw string error');
			results = await validator.validateAgainstXsd('<md:EntityDescriptor/>');
			expect(results.some(r => r.message.includes('raw string error'))).toBe(true);

			const errWithStack = new Error('Stack error');
			errWithStack.stack = 'Error stack trace';
			globalThis.fetch = vi.fn().mockRejectedValueOnce(errWithStack);
			results = await validator.validateAgainstXsd('<md:EntityDescriptor/>');
			expect(results.some(r => r.message.includes('Error stack trace'))).toBe(true);
		});
	});

	describe('verifyXmlSignature', () => {
		it('should return info when no Signature element is found', async () => {
			const validator = new SamlValidator();
			const parser = new window.DOMParser();
			const xmlDoc = parser.parseFromString('<md:EntityDescriptor/>', 'text/xml');
			const results = await validator.verifyXmlSignature(xmlDoc);
			expect(results).toEqual([{type: 'info', message: 'XML Signature: No ds:Signature element found.'}]);
		});

		it('should verify XML signature successfully when verified is true with SignatureMethod', async () => {
			const validator = new SamlValidator();
			const parser = new window.DOMParser();
			const xmlDoc = parser.parseFromString(
				'<root><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" verify-true="true"><ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/></ds:Signature></root>',
				'text/xml'
			);
			const results = await validator.verifyXmlSignature(xmlDoc);
			expect(results.some(r => r.type === 'success' && r.message.includes('rsa-sha256'))).toBe(true);
		});

		it('should verify using lowercase verify() method', async () => {
			mockLowercaseVerify = true;
			const validator = new SamlValidator();
			const parser = new window.DOMParser();
			const xmlDoc = parser.parseFromString(
				'<root><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"/></root>',
				'text/xml'
			);
			const results = await validator.verifyXmlSignature(xmlDoc);
			expect(results.some(r => r.type === 'success')).toBe(true);
		});

		it('should handle signature verification failure with validationResult and SignatureMethod', async () => {
			const validator = new SamlValidator();
			const parser = new window.DOMParser();
			const xmlDoc = parser.parseFromString(
				'<root><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignatureMethod Algorithm="http://alg"/></ds:Signature></root>',
				'text/xml'
			);
			const results = await validator.verifyXmlSignature(xmlDoc);
			expect(results.some(r => r.message.includes('XML Signature verification failed (http://alg)'))).toBe(true);
		});

		it('should handle signature error fallback when JSON.stringify throws (circular error)', async () => {
			const validator = new SamlValidator();
			const parser = new window.DOMParser();
			const xmlDoc = parser.parseFromString(
				'<root><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" circular-err="true"/></root>',
				'text/xml'
			);
			const results = await validator.verifyXmlSignature(xmlDoc);
			expect(results.some(r => r.message.includes('XML Signature verification error'))).toBe(true);
		});

		it('should handle outer catch in verifyXmlSignature when xmlDoc operations throw', async () => {
			const validator = new SamlValidator();
			const badXmlDoc = {
				getElementsByTagNameNS: () => {
					throw new Error('DOM fail');
				}
			};
			const results = await validator.verifyXmlSignature(badXmlDoc);
			expect(results).toEqual([]);
		});

		it('should handle missing SignedXml class in module', async () => {
			mockMissingSignedXml = true;
			const validator = new SamlValidator();
			const parser = new window.DOMParser();
			const xmlDoc = parser.parseFromString(
				'<root><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"/></root>',
				'text/xml'
			);
			const results = await validator.verifyXmlSignature(xmlDoc);
			expect(results.some(r => r.message.includes('xmldsigjs SignedXml class not found'))).toBe(true);
		});
	});

	describe('runCustomChecks & nsResolver', () => {
		it('should evaluate nsResolver with various prefixes and edge cases', () => {
			const config = [
				{
					label: 'Boolean check with nsResolver',
					xpath: '//custom:elem',
				},
			];
			const validator = new SamlValidator(config);
			const parser = new window.DOMParser();
			const xmlDoc = parser.parseFromString(
				'<root xmlns="urn:default" xmlns:custom="urn:custom"><custom:elem/></root>',
				'text/xml'
			);
			const results = validator.runCustomChecks(xmlDoc);
			expect(results.some(r => r.message.includes('Present: Boolean check with nsResolver'))).toBe(true);
		});

		it('should handle nsResolver branches: falsy prefix, missing docElement, and default namespace', () => {
			const validator = new SamlValidator([
				{
					label: 'Check default ns',
					xpath: '//elem',
				},
			]);
			const parser = new window.DOMParser();
			const xmlDoc = parser.parseFromString('<root xmlns="urn:default"><elem/></root>', 'text/xml');

			vi.spyOn(xmlDoc, 'evaluate').mockImplementation((xpath, contextNode, resolver, type) => {
				resolver(''); // triggers !prefix -> null
				resolver('default'); // triggers defaultNs
				resolver('unknown'); // triggers null
				return {booleanValue: true, snapshotLength: 0, snapshotItem: () => null};
			});

			const results = validator.runCustomChecks(xmlDoc);
			expect(results.length).toBe(1);

			// Test nsResolver when docElement is null
			const docNoRoot = {
				documentElement: null,
				evaluate: (xpath, ctx, resolver) => {
					resolver('custom'); // triggers !docElement -> null
					return {booleanValue: false, snapshotLength: 0, snapshotItem: () => null};
				}
			};
			const resultsNoDoc = validator.runCustomChecks(docNoRoot);
			expect(resultsNoDoc.length).toBe(1);
		});

		it('should evaluate children-required checks: missing node, missing child, present child', () => {
			const config = [
				{
					label: 'Missing node check',
					xpath: '//nonexistent',
					'children-required': ['child'],
				},
				{
					label: 'Child check',
					xpath: '//root',
					'children-required': ['<md:child>', 'plainchild'],
				},
			];
			const validator = new SamlValidator(config);
			const parser = new window.DOMParser();
			const xmlDoc = parser.parseFromString(
				'<root xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"><md:child/><plainchild/></root>',
				'text/xml'
			);
			const results = validator.runCustomChecks(xmlDoc);
			expect(results.some(r => r.message.includes('Missing: Missing node check'))).toBe(true);
			expect(results.some(r => r.message.includes('Present child: <md:child>'))).toBe(true);
			expect(results.some(r => r.message.includes('Present child: plainchild'))).toBe(true);

			// Test missing child branch
			validator.setConfig([
				{
					label: 'Missing child check',
					xpath: '//root',
					'children-required': ['absentchild', '<md:absent>'],
				},
			]);
			const missingResults = validator.runCustomChecks(xmlDoc);
			expect(missingResults.some(r => r.message.includes('Missing child: absentchild'))).toBe(true);
			expect(missingResults.some(r => r.message.includes('Missing child: <md:absent>'))).toBe(true);
		});

		it('should evaluate regexp-match checks: missing node, matching text, non-matching text', () => {
			const config = [
				{
					label: 'Regexp missing node',
					xpath: '//nonexistent',
					'regexp-match': '^[0-9]+$',
				},
				{
					label: 'Regexp match',
					xpath: '//match',
					'regexp-match': '^[0-9]+$',
				},
				{
					label: 'Regexp non-match',
					xpath: '//nonmatch',
					'regexp-match': '^[0-9]+$',
				},
			];
			const validator = new SamlValidator(config);
			const parser = new window.DOMParser();
			const xmlDoc = parser.parseFromString(
				'<root><match>12345</match><nonmatch>abc</nonmatch></root>',
				'text/xml'
			);
			const results = validator.runCustomChecks(xmlDoc);
			expect(results.some(r => r.message.includes('Missing: Regexp missing node'))).toBe(true);
			expect(results.some(r => r.message.includes('Present: Regexp match'))).toBe(true);
			expect(results.some(r => r.message.includes('Invalid format: Regexp non-match'))).toBe(true);
		});

		it('should evaluate max-occurrences / occurrence-max checks: missing node, valid count, too many occurrences', () => {
			const config = [
				{
					label: 'Occur missing',
					xpath: '//nonexistent',
					'occurrence-max': 1,
				},
				{
					label: 'Occur valid',
					xpath: '//item',
					'occurence-max': 2, // test alternative spelling
				},
				{
					label: 'Occur too many',
					xpath: '//item',
					'occurrence-max': 1,
				},
			];
			const validator = new SamlValidator(config);
			const parser = new window.DOMParser();
			const xmlDoc = parser.parseFromString(
				'<root><item/><item/></root>',
				'text/xml'
			);
			const results = validator.runCustomChecks(xmlDoc);
			expect(results.some(r => r.message.includes('Missing: Occur missing'))).toBe(true);
			expect(results.some(r => r.message.includes('Present: Occur valid'))).toBe(true);
			expect(results.some(r => r.message.includes('Too many: Occur too many (found 2, maximum allowed 1)'))).toBe(true);
		});

		it('should evaluate boolean expression checks: true and false results', () => {
			const config = [
				{
					label: 'Bool true',
					xpath: 'boolean(//root)',
				},
				{
					label: 'Bool false',
					xpath: 'boolean(//nonexistent)',
				},
			];
			const validator = new SamlValidator(config);
			const parser = new window.DOMParser();
			const xmlDoc = parser.parseFromString('<root/>', 'text/xml');
			const results = validator.runCustomChecks(xmlDoc);
			expect(results.some(r => r.message.includes('Present: Bool true'))).toBe(true);
			expect(results.some(r => r.message.includes('Missing: Bool false'))).toBe(true);
		});
	});

	describe('end-to-end validate() orchestration', () => {
		it('should return empty array for empty input', async () => {
			const validator = new SamlValidator();
			const results = await validator.validate('   ');
			expect(results).toEqual([]);
		});

		it('should stop on syntax error', async () => {
			const validator = new SamlValidator();
			const results = await validator.validate('<malformed');
			expect(results.length).toBe(1);
			expect(results[0].type).toBe('error');
			expect(results[0].message).toContain('XML Syntax Error');
		});

		it('should catch unexpected errors in validate() try/catch', async () => {
			const validator = new SamlValidator();
			vi.spyOn(validator, 'validateSyntax').mockImplementationOnce(() => {
				throw new Error('Boom');
			});
			const results = await validator.validate('<root/>');
			expect(results).toEqual([{type: 'error', message: 'Unexpected Error: Boom'}]);
		});

		it('should orchestrate successful full validation through all steps', async () => {
			validateXML.mockResolvedValueOnce({errors: []});
			const validator = new SamlValidator([{label: 'Test check', xpath: 'boolean(//root)'}]);

			globalThis.fetch = vi.fn().mockImplementation(() => {
				return Promise.resolve({
					ok: true,
					headers: {get: () => 'text/xml'},
					text: () => Promise.resolve('<xs:schema></xs:schema>'),
				});
			});

			const validXml = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:mdui="urn:oasis:names:tc:SAML:metadata:ui" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
        <ds:Signature verify-true="true"/>
      </md:EntityDescriptor>`;

			const results = await validator.validate(validXml);
			expect(results.some(r => r.type === 'success')).toBe(true);
		});
	});
});
