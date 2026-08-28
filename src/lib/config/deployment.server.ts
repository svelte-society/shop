import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import { SHOP_CONFIG } from './shop';
import { backupEncryptionKeyIsValid } from '$lib/server/backups/format';
import {
	s3BackupStoreOptionsAreValid,
	type S3BackupStoreOptions
} from '$lib/server/backups/s3.server';
import {
	RESEND_DEFAULT_BASE_URL,
	RESEND_DEFAULT_TIMEOUT_MS
} from '$lib/server/email/resend.server';
import { normalizeHttpsProviderBaseUrl } from '$lib/server/http/provider-url.server';
import {
	STYRIA_DEFAULT_BASE_URL,
	STYRIA_DEFAULT_TIMEOUT_MS
} from '$lib/server/styria/client.server';
import { parseWithdrawalDataKey } from '$lib/server/withdrawals/crypto.server';

export type RuntimeEnvironment = Record<string, string | undefined>;

type ConfigurationErrorCode = 'APPLICATION_CONFIG_INVALID' | 'MCP_CONFIG_INVALID';

export type DeploymentFeatures = {
	storefrontEnabled: boolean;
	checkoutEnabled: boolean;
	mcpEnabled: boolean;
	schedulerEnabled: boolean;
	automaticStyriaSubmissionEnabled: boolean;
};

export type DeploymentReadinessConfig = {
	features: DeploymentFeatures;
	databaseBootstrap: boolean;
	productionReady: boolean;
};

export type DeploymentWithdrawalConfig = {
	dataKey: Buffer;
	productionOrigin: URL;
	supportEmail: string;
	seller: {
		legalName: string;
		registrationNumber: string;
		addressLine1: string;
		postalCode: string;
		city: string;
		country: string;
		email: string;
	};
};

export type ResendDeploymentConfig = {
	apiKey: string;
	baseUrl: string;
	timeoutMs: number;
};

type DisabledBackupConfig = {
	status: 'disabled';
};

type InvalidBackupConfig = {
	status: 'invalid';
};

export type ConfiguredBackupConfig = {
	status: 'configured';
	store: S3BackupStoreOptions;
	encryptionKeyBase64: string;
	prefix: string;
	temporaryDirectory: string;
};

export type BackupDeploymentConfig =
	DisabledBackupConfig | InvalidBackupConfig | ConfiguredBackupConfig;

type OptionalStyriaDeploymentConfig = {
	appId?: string;
	secretKey?: string;
	baseUrl: string;
	timeoutMs: number;
	configurationValid: boolean;
};

export type ApplicationDeploymentConfig = {
	database: {
		path: string;
		bootstrap: boolean;
	};
	features: Pick<DeploymentFeatures, 'schedulerEnabled' | 'automaticStyriaSubmissionEnabled'>;
	withdrawal: DeploymentWithdrawalConfig;
	email: {
		provider: ResendDeploymentConfig;
		from: {
			name: string;
			email: string;
		};
		adminEmail: string;
	};
	stripeSecretKey?: string;
	styria: OptionalStyriaDeploymentConfig;
	backup: BackupDeploymentConfig;
	readiness: DeploymentReadinessConfig;
};

export type SchedulerDeploymentConfig = {
	stripeSecretKey: string;
	styria: {
		appId: string;
		secretKey: string;
		baseUrl: string;
		timeoutMs: number;
		brandName: string;
	};
	backup: DisabledBackupConfig | ConfiguredBackupConfig;
};

export type McpDeploymentConfig = {
	stripeSecretKey: string;
	styria: {
		appId: string;
		secretKey: string;
		baseUrl: string;
		timeoutMs: number;
		brandName: string;
	};
	withdrawal: DeploymentWithdrawalConfig;
	email: {
		from: {
			name: string;
			email: string;
		};
	};
};

const MCP_BEARER_PATTERN = /^[a-f0-9]{64}$/u;
const DEFAULT_S3_REGION = 'eu-north-1';
const DEFAULT_S3_PREFIX = 'svelte-society-shop';

function invalid(code: ConfigurationErrorCode): never {
	throw new Error(code);
}

function exactValue(value: string | undefined, maximum = 2_000): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= maximum &&
		value === value.trim() &&
		!/\r|\n/u.test(value)
	);
}

function requiredValue(
	environment: RuntimeEnvironment,
	name: string,
	code: ConfigurationErrorCode,
	maximum = 2_000
): string {
	const value = environment[name];
	if (!exactValue(value, maximum)) invalid(code);
	return value;
}

function optionalValue(environment: RuntimeEnvironment, name: string): string | undefined {
	const value = environment[name];
	return exactValue(value) ? value : undefined;
}

function optionalBoolean(
	environment: RuntimeEnvironment,
	name: string,
	code: ConfigurationErrorCode
): boolean {
	const value = environment[name];
	if (value === undefined || value === 'false') return false;
	if (value === 'true') return true;
	invalid(code);
}

function exactBoolean(environment: RuntimeEnvironment, name: string): boolean {
	return environment[name] === 'true' || environment[name] === 'false';
}

function httpsUrl(value: string | undefined): URL | undefined {
	if (!exactValue(value)) return undefined;
	try {
		const parsed = new URL(value);
		return parsed.protocol === 'https:' ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function productionOrigin(environment: RuntimeEnvironment, code: ConfigurationErrorCode): URL {
	const origin = httpsUrl(environment.PRODUCTION_ORIGIN);
	if (!origin) invalid(code);
	return origin;
}

function providerBaseUrl(
	environment: RuntimeEnvironment,
	name: 'RESEND_BASE_URL' | 'STYRIA_BASE_URL',
	fallback: string
): { value: string; valid: boolean } {
	const configured = environment[name];
	if (configured === undefined || configured === '') return { value: fallback, valid: true };
	const normalized = normalizeHttpsProviderBaseUrl(configured);
	return normalized === null
		? { value: fallback, valid: false }
		: { value: normalized, valid: true };
}

function styriaTimeout(environment: RuntimeEnvironment): { value: number; valid: boolean } {
	const configured = environment.STYRIA_TIMEOUT_MS;
	if (configured === undefined || configured === '') {
		return { value: STYRIA_DEFAULT_TIMEOUT_MS, valid: true };
	}
	if (!/^[1-9]\d*$/u.test(configured)) {
		return { value: STYRIA_DEFAULT_TIMEOUT_MS, valid: false };
	}
	const parsed = Number(configured);
	return Number.isSafeInteger(parsed) && parsed <= STYRIA_DEFAULT_TIMEOUT_MS
		? { value: parsed, valid: true }
		: { value: STYRIA_DEFAULT_TIMEOUT_MS, valid: false };
}

function parseWithdrawalConfig(
	environment: RuntimeEnvironment,
	code: ConfigurationErrorCode
): DeploymentWithdrawalConfig {
	try {
		return {
			dataKey: parseWithdrawalDataKey(environment.WITHDRAWAL_DATA_KEY),
			productionOrigin: productionOrigin(environment, code),
			supportEmail: SHOP_CONFIG.contact.supportEmail,
			seller: {
				legalName: SHOP_CONFIG.sellerPolicy.legalName,
				registrationNumber: SHOP_CONFIG.sellerPolicy.registrationNumber,
				addressLine1: SHOP_CONFIG.sellerPolicy.addressLine1,
				postalCode: SHOP_CONFIG.sellerPolicy.postalCode,
				city: SHOP_CONFIG.sellerPolicy.city,
				country: SHOP_CONFIG.sellerPolicy.country,
				email: SHOP_CONFIG.contact.sellerEmail
			}
		};
	} catch {
		invalid(code);
	}
}

export function parseResendDeploymentConfig(
	environment: RuntimeEnvironment,
	code: ConfigurationErrorCode
): ResendDeploymentConfig {
	const baseUrl = providerBaseUrl(environment, 'RESEND_BASE_URL', RESEND_DEFAULT_BASE_URL);
	if (!baseUrl.valid) invalid(code);
	return {
		apiKey: requiredValue(environment, 'RESEND_API_KEY', code, 500),
		baseUrl: baseUrl.value,
		timeoutMs: RESEND_DEFAULT_TIMEOUT_MS
	};
}

function backupConfigurationIsDisabled(environment: RuntimeEnvironment): boolean {
	const empty = (name: string): boolean => {
		const value = environment[name];
		return value === undefined || value === '';
	};
	return (
		['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].every(empty) &&
		(empty('S3_REGION') || environment.S3_REGION === DEFAULT_S3_REGION) &&
		(empty('S3_PREFIX') || environment.S3_PREFIX === DEFAULT_S3_PREFIX) &&
		(empty('S3_FORCE_PATH_STYLE') || environment.S3_FORCE_PATH_STYLE === 'false')
	);
}

function parseBackupConfig(environment: RuntimeEnvironment): BackupDeploymentConfig {
	if (backupConfigurationIsDisabled(environment)) return { status: 'disabled' };

	const region = environment.S3_REGION || DEFAULT_S3_REGION;
	const prefix = environment.S3_PREFIX || DEFAULT_S3_PREFIX;
	const forcePathStyle = environment.S3_FORCE_PATH_STYLE || 'false';
	const store = {
		endpoint: environment.S3_ENDPOINT ?? '',
		region,
		bucket: environment.S3_BUCKET ?? '',
		accessKeyId: environment.S3_ACCESS_KEY_ID ?? '',
		secretAccessKey: environment.S3_SECRET_ACCESS_KEY ?? '',
		forcePathStyle: forcePathStyle === 'true'
	};
	if (
		(forcePathStyle !== 'true' && forcePathStyle !== 'false') ||
		!exactValue(prefix) ||
		prefix.split('/').some((part) => part === '.' || part === '..') ||
		!backupEncryptionKeyIsValid(environment.BACKUP_ENCRYPTION_KEY_BASE64) ||
		!s3BackupStoreOptionsAreValid(store)
	) {
		return { status: 'invalid' };
	}
	return {
		status: 'configured',
		store,
		encryptionKeyBase64: environment.BACKUP_ENCRYPTION_KEY_BASE64,
		prefix,
		temporaryDirectory: environment.TMPDIR ?? tmpdir()
	};
}

function withdrawalDataKeyIsValid(environment: RuntimeEnvironment): boolean {
	try {
		parseWithdrawalDataKey(environment.WITHDRAWAL_DATA_KEY);
		return true;
	} catch {
		return false;
	}
}

function deploymentFeatures(environment: RuntimeEnvironment): DeploymentFeatures {
	return {
		storefrontEnabled: environment.STOREFRONT_ENABLED === 'true',
		checkoutEnabled: environment.CHECKOUT_ENABLED === 'true',
		mcpEnabled: environment.MCP_ENABLED === 'true',
		schedulerEnabled: environment.SCHEDULER_ENABLED === 'true',
		automaticStyriaSubmissionEnabled: environment.STYRIA_AUTO_SUBMIT_ENABLED === 'true'
	};
}

export function inspectDeploymentReadiness(
	environment: RuntimeEnvironment
): DeploymentReadinessConfig {
	const features = deploymentFeatures(environment);
	const databaseBootstrap = environment.DATABASE_BOOTSTRAP === 'true';
	const commerceEnabled = features.storefrontEnabled || features.checkoutEnabled;
	const fulfillmentEnabled = features.mcpEnabled || features.schedulerEnabled;
	const resendBaseUrl = providerBaseUrl(environment, 'RESEND_BASE_URL', RESEND_DEFAULT_BASE_URL);
	const styriaBaseUrl = providerBaseUrl(environment, 'STYRIA_BASE_URL', STYRIA_DEFAULT_BASE_URL);
	const styriaTimeoutOverride = styriaTimeout(environment);
	const backup = parseBackupConfig(environment);

	let productionReady =
		exactBoolean(environment, 'STOREFRONT_ENABLED') &&
		exactBoolean(environment, 'CHECKOUT_ENABLED') &&
		exactBoolean(environment, 'MCP_ENABLED') &&
		exactBoolean(environment, 'SCHEDULER_ENABLED') &&
		exactBoolean(environment, 'STYRIA_AUTO_SUBMIT_ENABLED') &&
		environment.DATABASE_BOOTSTRAP === 'false' &&
		exactValue(environment.DATABASE_PATH) &&
		isAbsolute(environment.DATABASE_PATH) &&
		Boolean(httpsUrl(environment.PRODUCTION_ORIGIN)) &&
		exactValue(environment.STRIPE_WEBHOOK_SECRET) &&
		exactValue(environment.RESEND_API_KEY, 500) &&
		resendBaseUrl.valid &&
		withdrawalDataKeyIsValid(environment);

	if (features.checkoutEnabled && !features.storefrontEnabled) productionReady = false;
	if (features.automaticStyriaSubmissionEnabled && !features.schedulerEnabled) {
		productionReady = false;
	}
	if (
		commerceEnabled &&
		(!exactValue(environment.STRIPE_SECRET_KEY) ||
			!exactValue(environment.STRIPE_PAID_SHIPPING_RATE_ID) ||
			!exactValue(environment.STRIPE_FREE_SHIPPING_RATE_ID))
	) {
		productionReady = false;
	}
	if (
		fulfillmentEnabled &&
		(!exactValue(environment.STRIPE_SECRET_KEY) ||
			!exactValue(environment.STYRIA_APP_ID) ||
			!exactValue(environment.STYRIA_SECRET_KEY) ||
			!styriaBaseUrl.valid ||
			!styriaTimeoutOverride.valid)
	) {
		productionReady = false;
	}
	if (features.mcpEnabled && !MCP_BEARER_PATTERN.test(environment.MCP_BEARER_TOKEN ?? '')) {
		productionReady = false;
	}
	if (features.schedulerEnabled && backup.status === 'invalid') productionReady = false;

	return { features, databaseBootstrap, productionReady };
}

export function parseApplicationDeploymentConfig(
	environment: RuntimeEnvironment
): ApplicationDeploymentConfig {
	const schedulerEnabled = optionalBoolean(
		environment,
		'SCHEDULER_ENABLED',
		'APPLICATION_CONFIG_INVALID'
	);
	const automaticStyriaSubmissionEnabled = optionalBoolean(
		environment,
		'STYRIA_AUTO_SUBMIT_ENABLED',
		'APPLICATION_CONFIG_INVALID'
	);
	if (automaticStyriaSubmissionEnabled && !schedulerEnabled) {
		invalid('APPLICATION_CONFIG_INVALID');
	}
	const databaseBootstrap = optionalBoolean(
		environment,
		'DATABASE_BOOTSTRAP',
		'APPLICATION_CONFIG_INVALID'
	);
	const withdrawal = parseWithdrawalConfig(environment, 'APPLICATION_CONFIG_INVALID');
	const styriaBaseUrl = providerBaseUrl(environment, 'STYRIA_BASE_URL', STYRIA_DEFAULT_BASE_URL);
	const timeout = styriaTimeout(environment);

	return {
		database: {
			path: requiredValue(environment, 'DATABASE_PATH', 'APPLICATION_CONFIG_INVALID'),
			bootstrap: databaseBootstrap
		},
		features: { schedulerEnabled, automaticStyriaSubmissionEnabled },
		withdrawal,
		email: {
			provider: parseResendDeploymentConfig(environment, 'APPLICATION_CONFIG_INVALID'),
			from: {
				name: SHOP_CONFIG.email.fromName,
				email: SHOP_CONFIG.email.fromAddress
			},
			adminEmail: SHOP_CONFIG.contact.adminEmail
		},
		stripeSecretKey: optionalValue(environment, 'STRIPE_SECRET_KEY'),
		styria: {
			appId: optionalValue(environment, 'STYRIA_APP_ID'),
			secretKey: optionalValue(environment, 'STYRIA_SECRET_KEY'),
			baseUrl: styriaBaseUrl.value,
			timeoutMs: timeout.value,
			configurationValid: styriaBaseUrl.valid && timeout.valid
		},
		backup: parseBackupConfig(environment),
		readiness: inspectDeploymentReadiness(environment)
	};
}

export function requireSchedulerDeploymentConfig(
	configuration: ApplicationDeploymentConfig
): SchedulerDeploymentConfig {
	if (
		!configuration.stripeSecretKey ||
		!configuration.styria.appId ||
		!configuration.styria.secretKey ||
		!configuration.styria.configurationValid ||
		configuration.backup.status === 'invalid'
	) {
		invalid('APPLICATION_CONFIG_INVALID');
	}
	return {
		stripeSecretKey: configuration.stripeSecretKey,
		styria: {
			appId: configuration.styria.appId,
			secretKey: configuration.styria.secretKey,
			baseUrl: configuration.styria.baseUrl,
			timeoutMs: configuration.styria.timeoutMs,
			brandName: SHOP_CONFIG.styria.brandName
		},
		backup: configuration.backup
	};
}

export function parseMcpDeploymentConfig(environment: RuntimeEnvironment): McpDeploymentConfig {
	const styriaBaseUrl = providerBaseUrl(environment, 'STYRIA_BASE_URL', STYRIA_DEFAULT_BASE_URL);
	const timeout = styriaTimeout(environment);
	if (!styriaBaseUrl.valid || !timeout.valid) invalid('MCP_CONFIG_INVALID');
	return {
		stripeSecretKey: requiredValue(environment, 'STRIPE_SECRET_KEY', 'MCP_CONFIG_INVALID'),
		styria: {
			appId: requiredValue(environment, 'STYRIA_APP_ID', 'MCP_CONFIG_INVALID'),
			secretKey: requiredValue(environment, 'STYRIA_SECRET_KEY', 'MCP_CONFIG_INVALID'),
			baseUrl: styriaBaseUrl.value,
			timeoutMs: timeout.value,
			brandName: SHOP_CONFIG.styria.brandName
		},
		withdrawal: parseWithdrawalConfig(environment, 'MCP_CONFIG_INVALID'),
		email: {
			from: {
				name: SHOP_CONFIG.email.fromName,
				email: SHOP_CONFIG.email.fromAddress
			}
		}
	};
}
