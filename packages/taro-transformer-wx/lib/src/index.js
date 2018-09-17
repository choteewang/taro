"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const babel_traverse_1 = require("babel-traverse");
const babel_generator_1 = require("babel-generator");
const fs = require("fs");
const class_1 = require("./class");
const html_1 = require("html");
const utils_1 = require("./utils");
const t = require("babel-types");
const constant_1 = require("./constant");
const babel_core_1 = require("babel-core");
const ts = require("typescript");
const template = require('babel-template');
function getIdsFromMemberProps(member) {
    let ids = [];
    const { object, property } = member;
    if (t.isMemberExpression(object)) {
        ids = ids.concat(getIdsFromMemberProps(object));
    }
    if (t.isThisExpression(object)) {
        ids.push('this');
    }
    if (t.isIdentifier(object)) {
        ids.push(object.name);
    }
    if (t.isIdentifier(property)) {
        ids.push(property.name);
    }
    return ids;
}
/**
 * TS 编译器会把 class property 移到构造器，
 * 而小程序要求 `config` 和所有函数在初始化(after new Class)之后就收集到所有的函数和 config 信息，
 * 所以当如构造器里有 this.func = () => {...} 的形式，就给他转换成普通的 classProperty function
 * 如果有 config 就给他还原
 */
function resetTSClassProperty(body) {
    for (const method of body) {
        if (t.isClassMethod(method) && method.kind === 'constructor') {
            if (t.isBlockStatement(method.body)) {
                method.body.body = method.body.body.filter(statement => {
                    if (t.isExpressionStatement(statement) && t.isAssignmentExpression(statement.expression)) {
                        const expr = statement.expression;
                        const { left, right } = expr;
                        if (t.isMemberExpression(left) &&
                            t.isThisExpression(left.object) &&
                            t.isIdentifier(left.property)) {
                            if ((t.isArrowFunctionExpression(right) || t.isFunctionExpression(right))
                                ||
                                    (left.property.name === 'config' && t.isObjectExpression(right))) {
                                const classProp = t.classProperty(left.property, right);
                                body.push(classProp);
                                handleThirdPartyComponent(classProp);
                                return false;
                            }
                        }
                    }
                    return true;
                });
            }
        }
    }
}
function findDeclarationScope(path, id) {
    const scopePath = path.findParent(p => !!p.scope.getOwnBindingIdentifier(id.name));
    if (scopePath) {
        return scopePath;
    }
    throw utils_1.codeFrameError(path.node, '该引用从未被定义');
}
function buildFullPathThisPropsRef(id, memberIds, path) {
    const scopePath = findDeclarationScope(path, id);
    const binding = scopePath.scope.getOwnBinding(id.name);
    if (binding) {
        const bindingPath = binding.path;
        if (bindingPath.isVariableDeclarator()) {
            const dclId = bindingPath.get('id');
            const dclInit = bindingPath.get('init');
            let dclInitIds = [];
            if (dclInit.isMemberExpression()) {
                dclInitIds = getIdsFromMemberProps(dclInit.node);
                if (dclId.isIdentifier()) {
                    memberIds.shift();
                }
                if (dclInitIds[0] === 'this' && dclInitIds[1] === 'props') {
                    return template(dclInitIds.concat(memberIds).join('.'))().expression;
                }
            }
        }
    }
}
function handleThirdPartyComponent(expr) {
    if (t.isClassProperty(expr) && expr.key.name === 'config' && t.isObjectExpression(expr.value)) {
        const properties = expr.value.properties;
        for (const prop of properties) {
            if (t.isObjectProperty(prop) &&
                (t.isIdentifier(prop.key, { name: 'usingComponents' }) || t.isStringLiteral(prop.key, { value: 'usingComponents' })) &&
                t.isObjectExpression(prop.value)) {
                for (const value of prop.value.properties) {
                    if (t.isObjectProperty(value)) {
                        if (t.isStringLiteral(value.key)) {
                            constant_1.THIRD_PARTY_COMPONENTS.add(value.key.value);
                        }
                        if (t.isIdentifier(value.key)) {
                            constant_1.THIRD_PARTY_COMPONENTS.add(value.key.name);
                        }
                    }
                }
            }
        }
    }
}
function transform(options) {
    const code = options.isTyped
        ? ts.transpile(options.code, {
            jsx: ts.JsxEmit.Preserve,
            target: ts.ScriptTarget.ESNext,
            importHelpers: true,
            noEmitHelpers: true
        })
        : options.code;
    utils_1.setting.sourceCode = code;
    // babel-traverse 无法生成 Hub
    // 导致 Path#getSource|buildCodeFrameError 都无法直接使用
    // 原因大概是 babylon.parse 没有生成 File 实例导致 scope 和 path 原型上都没有 `file`
    // 将来升级到 babel@7 可以直接用 parse 而不是 transform
    const ast = babel_core_1.transform(code, {
        parserOpts: {
            sourceType: 'module',
            plugins: [
                'classProperties',
                'jsx',
                'flow',
                'flowComment',
                'trailingFunctionCommas',
                'asyncFunctions',
                'exponentiationOperator',
                'asyncGenerators',
                'objectRestSpread',
                'decorators',
                'dynamicImport'
            ]
        },
        plugins: [
            require('babel-plugin-transform-flow-strip-types'),
            [require('babel-plugin-danger-remove-unused-import'), { ignore: ['@tarojs/taro', 'react', 'nervjs'] }],
            require('babel-plugin-transform-es2015-template-literals'),
            [require('babel-plugin-transform-define').default, {
                    'process.env.TARO_ENV': 'weapp'
                }]
        ].concat((process.env.NODE_ENV === 'test') ? [] : require('babel-plugin-remove-dead-code').default)
    }).ast;
    if (options.isNormal) {
        return { ast };
    }
    // transformFromAst(ast, code)
    let result;
    const componentSourceMap = new Map();
    const imageSource = new Set();
    let componentProperies = [];
    let mainClass;
    let storeName;
    let renderMethod;
    babel_traverse_1.default(ast, {
        ClassDeclaration(path) {
            mainClass = path;
            const superClass = path.node.superClass;
            if (t.isIdentifier(superClass)) {
                const binding = path.scope.getBinding(superClass.name);
                if (binding && binding.kind === 'module') {
                    const bindingPath = binding.path.parentPath;
                    if (bindingPath.isImportDeclaration()) {
                        const source = bindingPath.node.source;
                        try {
                            const p = fs.existsSync(source.value + '.js') ? source.value + '.js' : source.value + '.tsx';
                            const code = fs.readFileSync(p, 'utf8');
                            componentProperies = transform({
                                isRoot: false,
                                isApp: false,
                                code,
                                isTyped: true,
                                sourcePath: source.value,
                                outputPath: source.value
                            }).componentProperies;
                        }
                        catch (error) {
                            //
                        }
                    }
                }
            }
        },
        ClassExpression(path) {
            mainClass = path;
        },
        ClassMethod(path) {
            if (t.isIdentifier(path.node.key) && path.node.key.name === 'render') {
                renderMethod = path;
            }
        },
        IfStatement(path) {
            const consequent = path.get('consequent');
            if (!consequent.isBlockStatement()) {
                consequent.replaceWith(t.blockStatement([
                    consequent.node
                ]));
            }
        },
        CallExpression(path) {
            const callee = path.get('callee');
            if (utils_1.isContainJSXElement(path)) {
                return;
            }
            if (callee.isReferencedMemberExpression()) {
                const id = utils_1.findFirstIdentifierFromMemberExpression(callee.node);
                const calleeIds = getIdsFromMemberProps(callee.node);
                if (t.isIdentifier(id) && id.name.startsWith('on')) {
                    const fullPath = buildFullPathThisPropsRef(id, calleeIds, path);
                    if (fullPath) {
                        path.replaceWith(t.callExpression(fullPath, path.node.arguments));
                    }
                }
            }
            if (callee.isReferencedIdentifier()) {
                const id = callee.node;
                const ids = [id.name];
                if (t.isIdentifier(id) && id.name.startsWith('on')) {
                    const fullPath = buildFullPathThisPropsRef(id, ids, path);
                    if (fullPath) {
                        path.replaceWith(t.callExpression(fullPath, path.node.arguments));
                    }
                }
            }
        },
        AwaitExpression() {
            const isAsyncImported = ast.program.body.some(statement => {
                return t.isImportDeclaration(statement) && statement.source.value === constant_1.ASYNC_PACKAGE_NAME;
            });
            if (!isAsyncImported) {
                ast.program.body.unshift(t.importDeclaration([], t.stringLiteral(constant_1.ASYNC_PACKAGE_NAME)));
            }
        },
        // JSXIdentifier (path) {
        //   const parentPath = path.parentPath
        //   if (!parentPath.isJSXAttribute()) {
        //     return
        //   }
        //   const element = parentPath.parentPath
        //   if (!element.isJSXOpeningElement()) {
        //     return
        //   }
        //   const elementName = element.get('name')
        //   if (!elementName.isJSXIdentifier()) {
        //     return
        //   }
        //   if (DEFAULT_Component_SET.has(elementName.node.name)) {
        //     return
        //   }
        //   const expr = parentPath.get('value.expression')
        // },
        JSXOpeningElement(path) {
            const { name } = path.node.name;
            if (name === 'Provider') {
                const modules = path.scope.getAllBindings('module');
                const providerBinding = Object.values(modules).some((m) => m.identifier.name === 'Provider');
                if (providerBinding) {
                    path.node.name = t.jSXIdentifier('View');
                    const store = path.node.attributes.find(attr => attr.name.name === 'store');
                    if (store && t.isJSXExpressionContainer(store.value) && t.isIdentifier(store.value.expression)) {
                        storeName = store.value.expression.name;
                    }
                    path.node.attributes = [];
                }
            }
            if (constant_1.IMAGE_COMPONENTS.has(name)) {
                for (const attr of path.node.attributes) {
                    if (attr.name.name === 'src') {
                        if (t.isStringLiteral(attr.value)) {
                            imageSource.add(attr.value.value);
                        }
                        else if (t.isJSXExpressionContainer(attr.value)) {
                            if (t.isStringLiteral(attr.value.expression)) {
                                imageSource.add(attr.value.expression.value);
                            }
                        }
                    }
                }
            }
        },
        JSXAttribute(path) {
            const { name, value } = path.node;
            if (!t.isJSXIdentifier(name) || value === null || t.isStringLiteral(value) || t.isJSXElement(value)) {
                return;
            }
            const expr = value.expression;
            const exprPath = path.get('value.expression');
            if (!t.isBinaryExpression(expr, { operator: '+' }) && !t.isLiteral(expr) && name.name === 'style') {
                const jsxID = path.findParent(p => p.isJSXOpeningElement()).get('name');
                if (jsxID && jsxID.isJSXIdentifier() && constant_1.DEFAULT_Component_SET.has(jsxID.node.name)) {
                    exprPath.replaceWith(t.callExpression(t.identifier(constant_1.INTERNAL_INLINE_STYLE), [expr]));
                }
            }
            if (name.name.startsWith('on')) {
                if (exprPath.isReferencedIdentifier()) {
                    const ids = [expr.name];
                    const fullPath = buildFullPathThisPropsRef(expr, ids, path);
                    if (fullPath) {
                        exprPath.replaceWith(fullPath);
                    }
                }
                if (exprPath.isReferencedMemberExpression()) {
                    const id = utils_1.findFirstIdentifierFromMemberExpression(expr);
                    const ids = getIdsFromMemberProps(expr);
                    if (t.isIdentifier(id)) {
                        const fullPath = buildFullPathThisPropsRef(id, ids, path);
                        if (fullPath) {
                            exprPath.replaceWith(fullPath);
                        }
                    }
                }
                // @TODO: bind 的处理待定
            }
        },
        ImportDeclaration(path) {
            const source = path.node.source.value;
            const names = [];
            if (source === constant_1.TARO_PACKAGE_NAME) {
                path.node.specifiers.push(t.importSpecifier(t.identifier(constant_1.INTERNAL_SAFE_GET), t.identifier(constant_1.INTERNAL_SAFE_GET)), t.importSpecifier(t.identifier(constant_1.INTERNAL_GET_ORIGNAL), t.identifier(constant_1.INTERNAL_GET_ORIGNAL)), t.importSpecifier(t.identifier(constant_1.INTERNAL_INLINE_STYLE), t.identifier(constant_1.INTERNAL_INLINE_STYLE)));
            }
            if (source === constant_1.REDUX_PACKAGE_NAME) {
                path.node.specifiers.forEach((s, index, specs) => {
                    if (s.local.name === 'Provider') {
                        specs.splice(index, 1);
                        specs.push(t.importSpecifier(t.identifier('setStore'), t.identifier('setStore')));
                    }
                });
            }
            path.traverse({
                ImportDefaultSpecifier(path) {
                    const name = path.node.local.name;
                    constant_1.DEFAULT_Component_SET.has(name) || names.push(name);
                },
                ImportSpecifier(path) {
                    const name = path.node.imported.name;
                    constant_1.DEFAULT_Component_SET.has(name) || names.push(name);
                    if (source === constant_1.TARO_PACKAGE_NAME && name === 'Component') {
                        path.node.local = t.identifier('__BaseComponent');
                    }
                }
            });
            componentSourceMap.set(source, names);
        }
    });
    if (!mainClass) {
        throw new Error('未找到 Taro.Component 的类定义');
    }
    mainClass.node.body.body.forEach(handleThirdPartyComponent);
    const storeBinding = mainClass.scope.getBinding(storeName);
    mainClass.scope.rename('Component', '__BaseComponent');
    if (storeBinding) {
        const statementPath = storeBinding.path.getStatementParent();
        if (statementPath) {
            ast.program.body.forEach((node, index, body) => {
                if (node === statementPath.node) {
                    body.splice(index + 1, 0, t.expressionStatement(t.callExpression(t.identifier('setStore'), [
                        t.identifier(storeName)
                    ])));
                }
            });
        }
    }
    resetTSClassProperty(mainClass.node.body.body);
    if (options.isApp) {
        renderMethod.replaceWith(t.classMethod('method', t.identifier('_createData'), [], t.blockStatement([])));
        return { ast };
    }
    result = new class_1.Transformer(mainClass, options.sourcePath, componentProperies).result;
    result.code = babel_generator_1.default(ast).code;
    result.ast = ast;
    result.template = html_1.prettyPrint(result.template);
    result.imageSrcs = Array.from(imageSource);
    return result;
}
exports.default = transform;
//# sourceMappingURL=index.js.map