import ts, {NodeArray, TypeAliasDeclaration} from 'typescript'
import {
	AnyZodObject,
	z,
	ZodArray,
	ZodDiscriminatedUnion,
	ZodEffects, ZodFunction, ZodIntersection, ZodMap,
	ZodRecord, ZodSet,
	ZodTuple,
	ZodTypeAny,
	ZodUnion
} from 'zod'
import {
	GetType,
	GetTypeFunction,
	LiteralType,
	RequiredZodToTsOptions,
	ZodToTsOptions,
	ZodToTsReturn,
	ZodToTsStore,
} from './types'
import {
	addJsDocComment,
	createTypeAlias,
	createTypeReferenceFromString,
	createUnknownKeywordNode,
	getIdentifierOrStringLiteral,
	maybeIdentifierToTypeReference,
	printNode,
} from './utils'
import {withGetType} from "./utils";
import {AnyZodTuple, ZodUnionOptions} from "zod/lib/types";

const { factory: f } = ts

const callGetType = (
	zod: ZodTypeAny & GetType,
	identifier: string,
	options: RequiredZodToTsOptions,
) => {
	let type: ReturnType<GetTypeFunction> | null = null

	// this must be called before accessing 'type'
	if (zod.getType) type = zod.getType(ts, identifier, options)
	return type
}

export const resolveOptions = (raw?: ZodToTsOptions): RequiredZodToTsOptions => {
	const resolved: RequiredZodToTsOptions = { resolveNativeEnums: true }
	return { ...resolved, ...raw }
}

export const zodToTs = (
	zod: ZodTypeAny,
	identifier?: string,
	options?: ZodToTsOptions,
): ZodToTsReturn => {
	const resolvedIdentifier = identifier ?? 'Identifier'

	const resolvedOptions = resolveOptions(options)

	const store: ZodToTsStore = { nativeEnums: [] }

	const node = zodToTsNode(zod, resolvedIdentifier, store, resolvedOptions)

	return { node, store }
}

const zodToTsNode = (
	zod: ZodTypeAny,
	identifier: string,
	store: ZodToTsStore,
	options: RequiredZodToTsOptions,
) => {
	const { typeName } = zod._def

	const getTypeType = callGetType(zod, identifier, options)
	// special case native enum, which needs an identifier node
	if (getTypeType && typeName !== 'ZodNativeEnum') {
		return maybeIdentifierToTypeReference(getTypeType)
	}

	const otherArgs = [identifier, store, options] as const

	switch (typeName) {
		case 'ZodString':
			return f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword)
		case 'ZodNumber':
			return f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword)
		case 'ZodBigInt':
			return f.createKeywordTypeNode(ts.SyntaxKind.BigIntKeyword)
		case 'ZodBoolean':
			return f.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword)
		case 'ZodDate':
			return f.createTypeReferenceNode(f.createIdentifier('Date'))
		case 'ZodUndefined':
			return f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword)
		case 'ZodNull':
			return f.createLiteralTypeNode(f.createNull())
		case 'ZodVoid':
			return f.createUnionTypeNode([
				f.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword),
				f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword),
			])
		case 'ZodAny':
			return f.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)
		case 'ZodUnknown':
			return createUnknownKeywordNode()
		case 'ZodNever':
			return f.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword)
		case 'ZodLazy': {
			// it is impossible to determine what the lazy value is referring to
			// so we force the user to declare it
			if (!getTypeType) return createTypeReferenceFromString(identifier)
			break
		}
		case 'ZodLiteral': {
			// z.literal('hi') -> 'hi'
			let literal: ts.LiteralExpression | ts.BooleanLiteral

			const literalValue = zod._def.value as LiteralType
			switch (typeof literalValue) {
				case 'number':
					literal = f.createNumericLiteral(literalValue)
					break
				case 'boolean':
					if (literalValue === true) literal = f.createTrue()
					else literal = f.createFalse()
					break
				default:
					literal = f.createStringLiteral(literalValue)
					break
			}

			return f.createLiteralTypeNode(literal)
		}
		case 'ZodObject': {
			const properties = Object.entries(zod._def.shape())

			const members: ts.TypeElement[] = properties.map(([key, value]) => {
				const nextZodNode = value as ZodTypeAny
				const type = zodToTsNode(nextZodNode, ...otherArgs)

				const { typeName: nextZodNodeTypeName } = nextZodNode._def
				const isOptional = nextZodNodeTypeName === 'ZodOptional' || nextZodNode.isOptional()

				const propertySignature = f.createPropertySignature(
					undefined,
					getIdentifierOrStringLiteral(key),
					isOptional ? f.createToken(ts.SyntaxKind.QuestionToken) : undefined,
					type,
				)

				if (nextZodNode.description) {
					addJsDocComment(propertySignature, nextZodNode.description)
				}

				return propertySignature
			})
			return f.createTypeLiteralNode(members)
		}

		case 'ZodArray': {
			const type = zodToTsNode(zod._def.type, ...otherArgs)
			const node = f.createArrayTypeNode(type)
			return node
		}

		case 'ZodEnum': {
			// z.enum['a', 'b', 'c'] -> 'a' | 'b' | 'c
			const types = zod._def.values.map((value: string) => f.createStringLiteral(value))
			return f.createUnionTypeNode(types)
		}

		case 'ZodUnion': {
			// z.union([z.string(), z.number()]) -> string | number
			const options: ZodTypeAny[] = zod._def.options
			const types: ts.TypeNode[] = options.map((option) => zodToTsNode(option, ...otherArgs))
			return f.createUnionTypeNode(types)
		}

		case 'ZodDiscriminatedUnion': {
			// z.discriminatedUnion('kind', [z.object({ kind: z.literal('a'), a: z.string() }), z.object({ kind: z.literal('b'), b: z.number() })]) -> { kind: 'a', a: string } | { kind: 'b', b: number }
			const options: ZodTypeAny[] = [...zod._def.options.values()]
			const types: ts.TypeNode[] = options.map((option) => zodToTsNode(option, ...otherArgs))
			return f.createUnionTypeNode(types)
		}

		case 'ZodEffects': {
			// ignore any effects, they won't factor into the types
			const node = zodToTsNode(zod._def.schema, ...otherArgs) as ts.TypeNode
			return node
		}

		case 'ZodNativeEnum': {
			// z.nativeEnum(Fruits) -> Fruits
			// can resolve Fruits into store and user can handle enums
			let type = getTypeType
			if (!type) return createUnknownKeywordNode()

			if (options.resolveNativeEnums) {
				const enumMembers = Object.entries(zod._def.values as Record<string, string | number>).map(([key, value]) => {
					const literal = typeof value === 'number'
						? f.createNumericLiteral(value)
						: f.createStringLiteral(value)

					return f.createEnumMember(
						getIdentifierOrStringLiteral(key),
						literal,
					)
				})

				if (ts.isIdentifier(type)) {
					store.nativeEnums.push(
						f.createEnumDeclaration(
							undefined,
							type,
							enumMembers,
						),
					)
				} else {
					throw new Error('getType on nativeEnum must return an identifier when resolveNativeEnums is set')
				}
			}

			type = maybeIdentifierToTypeReference(type)

			return type
		}

		case 'ZodOptional': {
			const innerType = zodToTsNode(zod._def.innerType, ...otherArgs) as ts.TypeNode
			return f.createUnionTypeNode([
				innerType,
				f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword),
			])
		}

		case 'ZodNullable': {
			const innerType = zodToTsNode(zod._def.innerType, ...otherArgs) as ts.TypeNode
			return f.createUnionTypeNode([
				innerType,
				f.createLiteralTypeNode(f.createNull()),
			])
		}

		case 'ZodTuple': {
			// z.tuple([z.string(), z.number()]) -> [string, number]
			const types = zod._def.items.map((option: ZodTypeAny) => zodToTsNode(option, ...otherArgs))
			return f.createTupleTypeNode(types)
		}

		case 'ZodRecord': {
			// z.record(z.number()) -> { [x: string]: number }
			const valueType = zodToTsNode(zod._def.valueType, ...otherArgs)

			const node = f.createTypeLiteralNode([f.createIndexSignature(
				undefined,
				[f.createParameterDeclaration(
					undefined,
					undefined,
					f.createIdentifier('x'),
					undefined,
					f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
					undefined,
				)],
				valueType,
			)])

			return node
		}

		case 'ZodMap': {
			// z.map(z.string()) -> Map<string>
			const valueType = zodToTsNode(zod._def.valueType, ...otherArgs)
			const keyType = zodToTsNode(zod._def.keyType, ...otherArgs)

			const node = f.createTypeReferenceNode(
				f.createIdentifier('Map'),
				[
					keyType,
					valueType,
				],
			)

			return node
		}

		case 'ZodSet': {
			// z.set(z.string()) -> Set<string>
			const type = zodToTsNode(zod._def.valueType, ...otherArgs)

			const node = f.createTypeReferenceNode(
				f.createIdentifier('Set'),
				[type],
			)
			return node
		}

		case 'ZodIntersection': {
			// z.number().and(z.string()) -> number & string
			const left = zodToTsNode(zod._def.left, ...otherArgs)
			const right = zodToTsNode(zod._def.right, ...otherArgs)
			const node = f.createIntersectionTypeNode([left, right])
			return node
		}

		case 'ZodPromise': {
			// z.promise(z.string()) -> Promise<string>
			const type = zodToTsNode(zod._def.type, ...otherArgs)

			const node = f.createTypeReferenceNode(
				f.createIdentifier('Promise'),
				[type],
			)

			return node
		}

		case 'ZodFunction': {
			// z.function().args(z.string()).returns(z.number()) -> (args_0: string) => number
			const argTypes = zod._def.args._def.items.map((arg: ZodTypeAny, index: number) => {
				const argType = zodToTsNode(arg, ...otherArgs)

				return f.createParameterDeclaration(
					undefined,
					undefined,
					f.createIdentifier(`args_${index}`),
					undefined,
					argType,
					undefined,
				)
			}) as ts.ParameterDeclaration[]

			argTypes.push(
				f.createParameterDeclaration(
					undefined,
					f.createToken(ts.SyntaxKind.DotDotDotToken),
					f.createIdentifier(`args_${argTypes.length}`),
					undefined,
					f.createArrayTypeNode(createUnknownKeywordNode()),
					undefined,
				),
			)

			const returnType = zodToTsNode(zod._def.returns, ...otherArgs)

			const node = f.createFunctionTypeNode(
				undefined,
				argTypes,
				returnType,
			)

			return node
		}

		case 'ZodDefault': {
			// z.string().optional().default('hi') -> string
			const type = zodToTsNode(zod._def.innerType, ...otherArgs) as ts.TypeNode

			const filteredNodes: ts.Node[] = []

			type.forEachChild((node) => {
				if (!([ts.SyntaxKind.UndefinedKeyword].includes(node.kind))) {
					filteredNodes.push(node)
				}
			})

			// @ts-expect-error needed to set children
			type.types = filteredNodes

			return type
		}
	}

	return f.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)
}


const recursiveWithGetType = (zod: z.ZodTypeAny, identifiersByType: Map<z.ZodTypeAny, ts.Identifier>) => {

	if (identifiersByType.has(zod)) {
		withGetType(zod, () => identifiersByType.get(zod)!)
	}

	const {typeName} = zod._def;
	switch (typeName) {
		case 'ZodEnum':
		case 'ZodNativeEnum':
		case 'ZodString':
		case 'ZodNumber':
		case 'ZodBigInt':
		case 'ZodBoolean':
		case 'ZodDate':
		case 'ZodUndefined':
		case 'ZodNull':
		case 'ZodVoid':
		case 'ZodAny':
		case 'ZodUnknown':
		case 'ZodNever':
		case 'ZodLiteral': {
			// Nothing to do for above
			break;
		}
		case 'ZodLazy': {
			break
		}
		case 'ZodArray': {
			recursiveWithGetType((zod as ZodArray<ZodTypeAny>).element, identifiersByType)
			break;
		}
		case 'ZodUnion':{
			const zdu = zod as ZodUnion<ZodUnionOptions>
			for (const option of zdu.options) {
				recursiveWithGetType(option, identifiersByType)
			}
			break;
		}
		case 'ZodDiscriminatedUnion': {
			const zdu = zod as ZodDiscriminatedUnion<string, AnyZodObject[]>
			for (const option of zdu.options) {
				recursiveWithGetType(option, identifiersByType)
			}
			break;
		}
		case 'ZodEffects': {
			recursiveWithGetType((zod as ZodEffects<ZodTypeAny>).innerType(), identifiersByType)
			break;
		}
		case 'ZodTuple': {
			const zodTuple = zod as ZodTuple
			for (const item of zodTuple.items) {
				recursiveWithGetType(item, identifiersByType)
			}
			break;
		}
		case 'ZodRecord': {
			const zodRecord = zod as ZodRecord
			recursiveWithGetType(zodRecord.keySchema, identifiersByType)
			recursiveWithGetType(zodRecord.valueSchema, identifiersByType)
			break
		}
		case 'ZodMap':{
			const zodMap = zod as ZodMap
			recursiveWithGetType(zodMap._def.keyType, identifiersByType)
			recursiveWithGetType(zodMap._def.valueType, identifiersByType)
			break
		}
		case 'ZodSet': {
			recursiveWithGetType((zod as ZodSet)._def.valueType, identifiersByType)
			break
		}
		case 'ZodIntersection': {
			const intersection = zod as ZodIntersection<ZodTypeAny, ZodTypeAny>
			recursiveWithGetType(intersection._def.left, identifiersByType)
			recursiveWithGetType(intersection._def.right, identifiersByType)
			break
		}
		case 'ZodBranded':
		case 'ZodNullable':
		case 'ZodOptional':
		case 'ZodDefault':
		case 'ZodPromise': {
			if ('unwrap' in zod && typeof zod.unwrap === 'function') {
				recursiveWithGetType(zod.unwrap(), identifiersByType)
			}
			break;
		}
		case 'ZodFunction': {
			const zodFunction = (zod as ZodFunction<AnyZodTuple, ZodTypeAny>)
			recursiveWithGetType(zodFunction.parameters(), identifiersByType)
			recursiveWithGetType(zodFunction.returnType(), identifiersByType)
			break;
		}
		case 'ZodObject': {
			const properties = Object.entries((zod as AnyZodObject).shape)
			for (const [_key, value] of properties) {
				if (value instanceof z.ZodType) {
					recursiveWithGetType(value, identifiersByType)
				}
			}
			break;
		}
	}
}

export const zodToTsMultiple = (objectGraph: {[identifier: string]: z.ZodTypeAny}, options?: ZodToTsOptions): {
	typeAliases: NodeArray<TypeAliasDeclaration>
	store: ZodToTsStore
} => {
	const typesByIdentifier = new Map(Object.entries(objectGraph).map(([key, value]) => [f.createIdentifier(key), value]))
	const identifiersByType = new Map<z.ZodTypeAny, ts.Identifier>([...typesByIdentifier.entries()].map(([key, value]) => ([value, key])))

	// traverse object graph, find references, wrap them with `withGetType`
	const zodTypes = [...typesByIdentifier.values()]
	for (const zodType of zodTypes) {
		recursiveWithGetType(zodType, identifiersByType)
	}

	const results = [...typesByIdentifier.entries()].map(([identifier, zodType]) => {
		// Must not print alias for root level types, otherwise all we will print is aliases
		// Clone the object and remove any getType function
		const clone: ZodTypeAny & {getType?: GetTypeFunction} = Object.assign(Object.create(Object.getPrototypeOf(zodType)), zodType)
		delete clone['getType']
		const {node, store} = zodToTs(clone, undefined, options)
		const typeAlias = f.createTypeAliasDeclaration(undefined, identifier, undefined, node)
		return {typeAlias, store}
	})


	return {
		typeAliases: f.createNodeArray(results.map(result => result.typeAlias)),
		store: {
			// eslint-disable-next-line unicorn/no-array-reduce
			nativeEnums: results.map(result => result.store.nativeEnums).reduce((previous, current) => [...previous, ...current])
		}
	}
}



export { createTypeAlias, printNode }
export { withGetType } from './utils'
export type { GetType, ZodToTsOptions }
