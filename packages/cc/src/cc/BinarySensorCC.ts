import {
	CommandClasses,
	MessagePriority,
	ValueMetadata,
	ZWaveError,
	ZWaveErrorCodes,
	parseBitMask,
	validatePayload,
	type IZWaveEndpoint,
	type MaybeNotKnown,
	type MessageOrCCLogEntry,
} from "@zwave-js/core/safe";
import type { ZWaveApplicationHost, ZWaveHost } from "@zwave-js/host/safe";
import { getEnumMemberName, isEnumMember } from "@zwave-js/shared/safe";
import { validateArgs } from "@zwave-js/transformers";
import {
	CCAPI,
	POLL_VALUE,
	PhysicalCCAPI,
	throwUnsupportedProperty,
	type PollValueImplementation,
} from "../lib/API";
import {
	CommandClass,
	gotDeserializationOptions,
	type CCCommandOptions,
	type CommandClassDeserializationOptions,
} from "../lib/CommandClass";
import {
	API,
	CCCommand,
	ccValue,
	ccValues,
	commandClass,
	expectedCCResponse,
	implementedVersion,
} from "../lib/CommandClassDecorators";
import { V } from "../lib/Values";
import { BinarySensorCommand, BinarySensorType } from "../lib/_Types";

export const BinarySensorCCValues = Object.freeze({
	...V.defineStaticCCValues(CommandClasses["Binary Sensor"], {
		...V.staticProperty("supportedSensorTypes", undefined, {
			internal: true,
		}),
	}),

	...V.defineDynamicCCValues(CommandClasses["Binary Sensor"], {
		...V.dynamicPropertyWithName(
			"state",
			/* property */ (sensorType: BinarySensorType) =>
				getEnumMemberName(BinarySensorType, sensorType),
			({ property }) =>
				typeof property === "string" && property in BinarySensorType,
			/* meta */ (sensorType: BinarySensorType) =>
				({
					...ValueMetadata.ReadOnlyBoolean,
					label: `Sensor state (${getEnumMemberName(
						BinarySensorType,
						sensorType,
					)})`,
					ccSpecific: { sensorType },
				} as const),
		),
	}),
});

// @noSetValueAPI This CC is read-only

@API(CommandClasses["Binary Sensor"])
export class BinarySensorCCAPI extends PhysicalCCAPI {
	public supportsCommand(cmd: BinarySensorCommand): MaybeNotKnown<boolean> {
		switch (cmd) {
			case BinarySensorCommand.Get:
				return true; // This is mandatory
			case BinarySensorCommand.SupportedGet:
				return this.version >= 2;
		}
		return super.supportsCommand(cmd);
	}

	protected get [POLL_VALUE](): PollValueImplementation {
		return async function (this: BinarySensorCCAPI, { property }) {
			if (typeof property === "string") {
				const sensorType = (BinarySensorType as any)[property] as
					| BinarySensorType
					| undefined;
				if (sensorType) return this.get(sensorType);
			}
			throwUnsupportedProperty(this.ccId, property);
		};
	}

	/**
	 * Retrieves the current value from this sensor
	 * @param sensorType The (optional) sensor type to retrieve the value for
	 */
	@validateArgs({ strictEnums: true })
	public async get(
		sensorType?: BinarySensorType,
	): Promise<MaybeNotKnown<boolean>> {
		this.assertSupportsCommand(
			BinarySensorCommand,
			BinarySensorCommand.Get,
		);

		const cc = new BinarySensorCCGet(this.applHost, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
			sensorType,
		});
		const response = await this.applHost.sendCommand<BinarySensorCCReport>(
			cc,
			this.commandOptions,
		);
		// We don't want to repeat the sensor type
		return response?.value;
	}

	// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
	public async getSupportedSensorTypes() {
		this.assertSupportsCommand(
			BinarySensorCommand,
			BinarySensorCommand.SupportedGet,
		);

		const cc = new BinarySensorCCSupportedGet(this.applHost, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
		});
		const response =
			await this.applHost.sendCommand<BinarySensorCCSupportedReport>(
				cc,
				this.commandOptions,
			);
		// We don't want to repeat the sensor type
		return response?.supportedSensorTypes;
	}
}

@commandClass(CommandClasses["Binary Sensor"])
@implementedVersion(2)
@ccValues(BinarySensorCCValues)
export class BinarySensorCC extends CommandClass {
	declare ccCommand: BinarySensorCommand;

	public async interview(applHost: ZWaveApplicationHost): Promise<void> {
		const node = this.getNode(applHost)!;
		const endpoint = this.getEndpoint(applHost)!;
		const api = CCAPI.create(
			CommandClasses["Binary Sensor"],
			applHost,
			endpoint,
		).withOptions({
			priority: MessagePriority.NodeQuery,
		});

		applHost.controllerLog.logNode(node.id, {
			endpoint: this.endpointIndex,
			message: `Interviewing ${this.ccName}...`,
			direction: "none",
		});

		// Find out which sensor types this sensor supports
		if (this.version >= 2) {
			applHost.controllerLog.logNode(node.id, {
				endpoint: this.endpointIndex,
				message: "querying supported sensor types...",
				direction: "outbound",
			});
			const supportedSensorTypes = await api.getSupportedSensorTypes();
			if (supportedSensorTypes) {
				const logMessage = `received supported sensor types: ${supportedSensorTypes
					.map((type) => getEnumMemberName(BinarySensorType, type))
					.map((name) => `\n· ${name}`)
					.join("")}`;
				applHost.controllerLog.logNode(node.id, {
					endpoint: this.endpointIndex,
					message: logMessage,
					direction: "inbound",
				});
			} else {
				applHost.controllerLog.logNode(node.id, {
					endpoint: this.endpointIndex,
					message:
						"Querying supported sensor types timed out, skipping interview...",
					level: "warn",
				});
				return;
			}
		}

		await this.refreshValues(applHost);

		// Remember that the interview is complete
		this.setInterviewComplete(applHost, true);
	}

	public async refreshValues(applHost: ZWaveApplicationHost): Promise<void> {
		const node = this.getNode(applHost)!;
		const endpoint = this.getEndpoint(applHost)!;
		const api = CCAPI.create(
			CommandClasses["Binary Sensor"],
			applHost,
			endpoint,
		).withOptions({
			priority: MessagePriority.NodeQuery,
		});

		// Query (all of) the sensor's current value(s)
		if (this.version === 1) {
			applHost.controllerLog.logNode(node.id, {
				endpoint: this.endpointIndex,
				message: "querying current value...",
				direction: "outbound",
			});
			const currentValue = await api.get();
			if (currentValue != undefined) {
				applHost.controllerLog.logNode(node.id, {
					endpoint: this.endpointIndex,
					message: `received current value: ${currentValue}`,
					direction: "inbound",
				});
			}
		} else {
			const supportedSensorTypes: readonly BinarySensorType[] =
				this.getValue(
					applHost,
					BinarySensorCCValues.supportedSensorTypes,
				) ?? [];

			for (const type of supportedSensorTypes) {
				// Some devices report invalid sensor types, but the CC API checks
				// for valid values and throws otherwise.
				if (!isEnumMember(BinarySensorType, type)) continue;

				const sensorName = getEnumMemberName(BinarySensorType, type);
				applHost.controllerLog.logNode(node.id, {
					endpoint: this.endpointIndex,
					message: `querying current value for ${sensorName}...`,
					direction: "outbound",
				});
				const currentValue = await api.get(type);
				if (currentValue != undefined) {
					applHost.controllerLog.logNode(node.id, {
						endpoint: this.endpointIndex,
						message: `received current value for ${sensorName}: ${currentValue}`,
						direction: "inbound",
					});
				}
			}
		}
	}

	/**
	 * Returns which sensor types are supported.
	 * This only works AFTER the interview process
	 */
	public static getSupportedSensorTypesCached(
		applHost: ZWaveApplicationHost,
		endpoint: IZWaveEndpoint,
	): MaybeNotKnown<BinarySensorType[]> {
		return applHost
			.getValueDB(endpoint.nodeId)
			.getValue(
				BinarySensorCCValues.supportedSensorTypes.endpoint(
					endpoint.index,
				),
			);
	}

	public setMappedBasicValue(
		applHost: ZWaveApplicationHost,
		value: number,
	): boolean {
		this.setValue(
			applHost,
			BinarySensorCCValues.state(BinarySensorType.Any),
			value > 0,
		);
		return true;
	}
}

@CCCommand(BinarySensorCommand.Report)
export class BinarySensorCCReport extends BinarySensorCC {
	public constructor(
		host: ZWaveHost,
		options: CommandClassDeserializationOptions,
	) {
		super(host, options);

		validatePayload(this.payload.length >= 1);
		this._value = this.payload[0] === 0xff;
		this._type = BinarySensorType.Any;
		if (this.version >= 2 && this.payload.length >= 2) {
			this._type = this.payload[1];
		}
	}

	public persistValues(applHost: ZWaveApplicationHost): boolean {
		if (!super.persistValues(applHost)) return false;

		const binarySensorValue = BinarySensorCCValues.state(this._type);
		this.setMetadata(applHost, binarySensorValue, binarySensorValue.meta);
		this.setValue(applHost, binarySensorValue, this._value);

		return true;
	}

	private _type: BinarySensorType;
	public get type(): BinarySensorType {
		return this._type;
	}

	private _value: boolean;
	public get value(): boolean {
		return this._value;
	}

	public toLogEntry(applHost: ZWaveApplicationHost): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(applHost),
			message: {
				type: getEnumMemberName(BinarySensorType, this._type),
				value: this._value,
			},
		};
	}
}

function testResponseForBinarySensorGet(
	sent: BinarySensorCCGet,
	received: BinarySensorCCReport,
) {
	// We expect a Binary Sensor Report that matches the requested sensor type (if a type was requested)
	return (
		sent.sensorType == undefined ||
		sent.sensorType === BinarySensorType.Any ||
		received.type === sent.sensorType
	);
}

interface BinarySensorCCGetOptions extends CCCommandOptions {
	sensorType?: BinarySensorType;
}

@CCCommand(BinarySensorCommand.Get)
@expectedCCResponse(BinarySensorCCReport, testResponseForBinarySensorGet)
export class BinarySensorCCGet extends BinarySensorCC {
	public constructor(
		host: ZWaveHost,
		options: CommandClassDeserializationOptions | BinarySensorCCGetOptions,
	) {
		super(host, options);
		if (gotDeserializationOptions(options)) {
			throw new ZWaveError(
				`${this.constructor.name}: deserialization not implemented`,
				ZWaveErrorCodes.Deserialization_NotImplemented,
			);
		} else {
			this.sensorType = options.sensorType;
		}
	}

	public sensorType: BinarySensorType | undefined;

	public serialize(): Buffer {
		if (this.version >= 2 && this.sensorType != undefined) {
			this.payload = Buffer.from([this.sensorType]);
		}
		return super.serialize();
	}

	public toLogEntry(applHost: ZWaveApplicationHost): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(applHost),
			message: {
				type: getEnumMemberName(
					BinarySensorType,
					this.sensorType ?? BinarySensorType.Any,
				),
			},
		};
	}
}

@CCCommand(BinarySensorCommand.SupportedReport)
export class BinarySensorCCSupportedReport extends BinarySensorCC {
	public constructor(
		host: ZWaveHost,
		options: CommandClassDeserializationOptions,
	) {
		super(host, options);

		validatePayload(this.payload.length >= 1);
		// The enumeration starts at 1, but the first (reserved) bit is included
		// in the report
		this.supportedSensorTypes = parseBitMask(this.payload, 0).filter(
			(t) => t !== 0,
		);
	}

	@ccValue(BinarySensorCCValues.supportedSensorTypes)
	public readonly supportedSensorTypes: readonly BinarySensorType[];

	public toLogEntry(applHost: ZWaveApplicationHost): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(applHost),
			message: {
				"supported types": this.supportedSensorTypes
					.map((type) => getEnumMemberName(BinarySensorType, type))
					.join(", "),
			},
		};
	}
}

@CCCommand(BinarySensorCommand.SupportedGet)
@expectedCCResponse(BinarySensorCCSupportedReport)
export class BinarySensorCCSupportedGet extends BinarySensorCC {}
