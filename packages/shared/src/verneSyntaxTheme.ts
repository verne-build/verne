import type { SyntaxTheme } from "./themePalettes.ts";

/** TextMate rules carried forward from Verne's VS Code-compatible theme. */
export const VERNE_DARK_SYNTAX_THEME = [
  {
    scope: [
      "comment",
      "comment keyword",
      "comment markup.underline.link",
      "comment string",
      "comment punctuation.definition",
      "comment punctuation",
      "comment text",
    ],
    settings: {
      foreground: "#6b7678",
      fontStyle: "italic",
    },
  },
  {
    scope: "comment storage.type",
    settings: {
      foreground: "#6b7678",
    },
  },
  {
    scope: "comment entity.name.type",
    settings: {
      foreground: "#b8c4c3",
    },
  },
  {
    scope: ["comment variable", "comment variable.other"],
    settings: {
      foreground: "#b8c4c3",
    },
  },
  {
    scope: ["comment keyword", "comment entity.name.tag", "entity.name.tag.documentation"],
    settings: {
      foreground: "#b8c4c3",
    },
  },
  {
    scope: "comment keyword.codetag.notation",
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: "comment.git-status.header.remote",
    settings: {
      foreground: "#ff6d7e",
    },
  },
  {
    scope: "comment.git-status.header.local",
    settings: {
      foreground: "#7cd5f1",
    },
  },
  {
    scope: "comment.other.git-status.head",
    settings: {
      foreground: "#f2fffc",
    },
  },
  {
    scope: ["string.quoted.docstring", "string.quoted.docstring punctuation.definition"],
    settings: {
      foreground: "#6b7678",
    },
  },
  {
    scope: "constant",
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: "constant.other",
    settings: {
      foreground: "#f2fffc",
    },
  },
  {
    scope: "constant.other.caps",
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: "constant.other.placeholder",
    settings: {
      foreground: "#ffb270",
    },
  },
  {
    scope: "constant.other.property",
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: "constant.other.citation.latex",
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: "constant.other.color",
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: "constant.other.character-class.escape",
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: "constant.other.key",
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: "constant.other.symbol",
    settings: {
      foreground: "#ffb270",
    },
  },
  {
    scope: "constant.other.elm",
    settings: {
      foreground: "#7cd5f1",
    },
  },
  {
    scope: "constant.numeric",
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: "constant.language",
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: "constant.character.escape",
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: "constant.numeric.line-number.find-in-files",
    settings: {
      foreground: "#545f62",
    },
  },
  {
    scope: "constant.numeric.line-number.match.find-in-files",
    settings: {
      foreground: "#ffed72",
    },
  },
  {
    scope: "entity.name.section",
    settings: {
      foreground: "#ffed72",
    },
  },
  {
    scope: [
      "entity.name.function",
      "entity.name.function.templated",
      "entity.name.function.member.static",
    ],
    settings: {
      foreground: "#a2e57b",
    },
  },
  {
    scope: [
      "entity.name.type.class.templated",
      "entity.name.type.class.generic",
      "entity.name.type.namespace",
    ],
    settings: {
      foreground: "#7cd5f1",
    },
  },
  {
    scope: "entity.name.label",
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: "entity.name.function.preprocessor",
    settings: {
      foreground: "#7cd5f1",
    },
  },
  {
    scope: "entity.name",
    settings: {
      foreground: "#a2e57b",
    },
  },
  {
    scope: "entity.name.class",
    settings: {
      foreground: "#7cd5f1",
    },
  },
  {
    scope: "entity.name.constant",
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: "entity.name.namespace",
    settings: {
      foreground: "#7cd5f1",
    },
  },
  {
    scope: "entity.other.inherited-class",
    settings: {
      foreground: "#7cd5f1",
      fontStyle: "italic",
    },
  },
  {
    scope: "entity.name.function",
    settings: {
      foreground: "#a2e57b",
    },
  },
  {
    scope: [
      "entity.name.tag",
      "entity.name.tag.js.jsx support.class.component.js.jsx",
      "entity.name.tag support.class.component",
      "source.vue support.class.component",
    ],
    settings: {
      foreground: "#ff6d7e",
    },
  },
  {
    scope: "source.ansible entity.name.tag",
    settings: {
      foreground: "#7cd5f1",
    },
  },
  {
    scope: "entity.name.function.operator",
    settings: {
      foreground: "#ff6d7e",
    },
  },
  {
    scope: [
      "meta.brackets entity.name.function.operator",
      "punctuation.separator entity.name.function.operator",
    ],
    settings: {
      foreground: "#8b9798",
    },
  },
  {
    scope: ["entity.name.type", "entity.name.type.class.reference", "entity.name.type.class.value"],
    settings: {
      foreground: "#7cd5f1",
    },
  },
  {
    scope: "entity.other.attribute-name",
    settings: {
      foreground: "#7cd5f1",
      fontStyle: "italic",
    },
  },
  {
    scope: [
      "entity.other.attribute-name.class.css",
      "entity.other.attribute-name.parent-selector-suffix.css",
      "entity.other.attribute-name.parent-selector-suffix.css punctuation.definition.entity.css",
      "entity.other.attribute-name.css",
      "entity.other.animation-name.css",
    ],
    settings: {
      foreground: "#a2e57b",
    },
  },
  {
    scope: "entity.other.attribute-name.id.css",
    settings: {
      foreground: "#ffb270",
    },
  },
  {
    scope: [
      "entity.other.attribute-name.pseudo-class.css",
      "entity.other.pseudo-class.css",
      "entity.other.pseudo-element.css",
    ],
    settings: {
      foreground: "#7cd5f1",
      fontStyle: "italic",
    },
  },
  {
    scope: ["entity.name.function", "support.function"],
    settings: {
      foreground: "#a2e57b",
    },
  },
  {
    scope: "entity.other.git-status.hex",
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: "entity.other.jinja2.delimiter",
    settings: {
      foreground: "#8b9798",
    },
  },
  {
    scope: "entity.name.operator.custom-literal",
    settings: {
      foreground: "#f2fffc",
    },
  },
  {
    scope: "entity.name.operator.custom-literal.string",
    settings: {
      foreground: "#ffed72",
    },
  },
  {
    scope: "entity.name.operator.custom-literal.number",
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: "entity.name.type.rust",
    settings: {
      foreground: "#7cd5f1",
    },
  },
  {
    scope: "entity.name.lifetime.rust",
    settings: {
      foreground: "#ff6d7e",
    },
  },
  {
    scope: "invalid",
    settings: {
      foreground: "#ff6d7e",
      fontStyle: "italic underline",
    },
  },
  {
    scope: "invalid.deprecated",
    settings: {
      foreground: "#ffb270",
      fontStyle: "italic underline",
    },
  },
  {
    scope: "keyword",
    settings: {
      foreground: "#ff6d7e",
    },
  },
  {
    scope: "keyword.control",
    settings: {
      foreground: "#ff6d7e",
    },
  },
  {
    scope: "keyword.control.directive",
    settings: {
      foreground: "#ff6d7e",
    },
  },
  {
    scope: ["keyword.operator", "keyword.operator.member", "keyword.operator.new"],
    settings: {
      foreground: "#ff6d7e",
    },
  },
  {
    scope: "keyword.other.substitution",
    settings: {
      foreground: "#8b9798",
    },
  },
  {
    scope: ["keyword.other.template.begin", "keyword.other.template.end"],
    settings: {
      foreground: "#ff6d7e",
    },
  },
  {
    scope: [
      "keyword.operator.heading.restructuredtext",
      "keyword.operator.table.row.restructuredtext keyword.operator.table.data.restructuredtext",
    ],
    settings: {
      foreground: "#8b9798",
    },
  },
  {
    scope: "keyword.other.parenthesis.elm",
    settings: {
      foreground: "#8b9798",
    },
  },
  {
    scope: [
      "keyword.other.fn.rust",
      "keyword.other.rust",
      "keyword.other.unsafe.rust",
      "keyword.other.where.rust",
    ],
    settings: {
      foreground: "#7cd5f1",
    },
  },
  {
    scope: ["keyword.control.rust", "keyword.operator.misc.rust"],
    settings: {
      foreground: "#ff6d7e",
    },
  },
  {
    scope: [
      "keyword.declaration.class.ruby",
      "keyword.declaration.function.ruby",
      "keyword.declaration.namespace.ruby",
    ],
    settings: {
      foreground: "#ff6d7e",
    },
  },
  {
    scope: "markup.italic",
    settings: {
      fontStyle: "italic",
    },
  },
  {
    scope: "markup.bold",
    settings: {
      fontStyle: "bold",
    },
  },
  {
    scope: "markup.heading",
    settings: {
      foreground: "#ffed72",
    },
  },
  {
    scope: "markup.raw",
    settings: {
      foreground: "#ffb270",
    },
  },
  {
    scope: "markup.underline",
    settings: {
      fontStyle: "underline",
    },
  },
  {
    scope: "markup.underline.link",
    settings: {
      foreground: "#a2e57b",
    },
  },
  {
    scope: ["markup.inserted", "markup.inserted punctuation.definition.inserted"],
    settings: {
      foreground: "#a2e57b",
    },
  },
  {
    scope: ["markup.deleted", "markup.deleted punctuation.definition.deleted"],
    settings: {
      foreground: "#ff6d7e",
    },
  },
  {
    scope: ["markup.changed", "markup.changed punctuation.definition.changed"],
    settings: {
      foreground: "#ffed72",
    },
  },
  {
    scope: ["markup.ignored", "markup.ignored punctuation.definition.ignored"],
    settings: {
      foreground: "#8b9798",
    },
  },
  {
    scope: "markup.untracked",
    settings: {
      foreground: "#8b9798",
    },
  },
  {
    scope: "markup.quote",
    settings: {
      fontStyle: "italic",
    },
  },
  {
    scope: [
      "meta.brace.round",
      "meta.brace.square",
      "meta.brace.curly",
      "meta.delimiter.comma.js",
      "meta.function-call.without-arguments.js",
      "meta.function-call.method.without-arguments.js",
    ],
    settings: {
      foreground: "#8b9798",
    },
  },
  {
    scope: ["meta.function-call.generic.python", "support.function.builtin.python"],
    settings: {
      foreground: "#a2e57b",
    },
  },
  {
    scope: "meta.function-call.python meta.function-call.arguments.python",
    settings: {
      foreground: "#f2fffc",
    },
  },
  {
    scope: "meta.interpolation",
    settings: {
      foreground: "#ffb270",
    },
  },
  {
    scope: "meta.instance.constructor",
    settings: {
      foreground: "#a2e57b",
    },
  },
  {
    scope: ["meta.attribute-with-value.class string", "meta.attribute.class.html string"],
    settings: {
      foreground: "#a2e57b",
    },
  },
  {
    scope: ["meta.attribute-with-value.id string", "meta.attribute.id.html string"],
    settings: {
      foreground: "#ffb270",
    },
  },
  {
    scope: "source.json meta.mapping.key string",
    settings: {
      foreground: "#f2fffc",
    },
  },
  {
    scope: "source.yaml meta.mapping.key string",
    settings: {
      foreground: "#ff6d7e",
    },
  },
  {
    scope: "meta.object.member",
    settings: {
      foreground: "#f2fffc",
    },
  },
  {
    scope: "meta.property-list.css variable.other",
    settings: {
      foreground: "#ffb270",
    },
  },
  {
    scope: ["entity.name.constant.preprocessor", "meta.preprocessor"],
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: "meta.diff.git-diff.header",
    settings: {
      foreground: "#ffed72",
    },
  },
  {
    scope: "meta.type_params.rust",
    settings: {
      foreground: "#f2fffc",
    },
  },
  {
    scope: [
      "meta.attribute.rust",
      "meta.annotation.rust",
      "variable.language.rust",
      "variable.annotation.rust",
      "meta.annotation.rust string",
      "meta.annotation.rust keyword",
      "meta.annotation.rust keyword.operator",
      "meta.attribute.rust string",
    ],
    settings: {
      foreground: "#b8c4c3",
    },
  },
  {
    scope: [
      "meta.type variable",
      "meta.type variable.other.readwrite",
      "variable.annotation",
      "meta.decorator variable.other.readwrite",
    ],
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: "punctuation",
    settings: {
      foreground: "#8b9798",
    },
  },
  {
    scope: [
      "punctuation.definition.tag",
      "punctuation.definition.tag source",
      "punctuation.definition.group.begin.ruby",
      "punctuation.definition.group.end.ruby",
      "punctuation.definition.group.begin.css",
      "punctuation.definition.group.end.css",
      "punctuation.definition.string.end.html source.css",
      "punctuation.definition.block",
      "punctuation.definition.parameters.begin",
      "punctuation.definition.parameters.end",
      "punctuation.separator.parameter",
      "punctuation.accessor",
      "punctuation.terminator",
    ],
    settings: {
      foreground: "#8b9798",
    },
  },
  {
    scope: "punctuation.definition.group",
    settings: {
      foreground: "#f2fffc",
    },
  },
  {
    scope: "punctuation.definition.comment",
    settings: {
      foreground: "#6b7678",
    },
  },
  {
    scope: [
      "punctuation.definition.variable",
      "punctuation.definition.keyword.scss",
      "punctuation.definition.entity.css",
    ],
    settings: {
      foreground: "#b8c4c3",
    },
  },
  {
    scope: [
      "punctuation.section.embedded",
      "punctuation.section.embedded entity.name.tag",
      "punctuation.section.embedded constant.other",
      "punctuation.section.embedded source",
      "punctuation.section.embedded.begin",
    ],
    settings: {
      foreground: "#ffb270",
    },
  },
  {
    scope: [
      "punctuation.template-string.element.begin",
      "punctuation.template-string.element.end",
      "punctuation.definition.string.template.begin",
      "punctuation.definition.string.template.end",
      "string.quoted.template punctuation.definition.string.begin",
      "string.quoted.template punctuation.definition.string.end",
      "punctuation.definition.template-expression.begin",
      "punctuation.definition.template-expression.end",
    ],
    settings: {
      foreground: "#ff6d7e",
    },
  },
  {
    scope: [
      "meta.paragraph.markdown meta.dummy.line-break",
      "meta.paragraph.markdown meta.hard-line-break.markdown",
    ],
    settings: {},
  },
  {
    scope: "markup.underline.link punctuation",
    settings: {
      foreground: "#a2e57b",
    },
  },
  {
    scope: [
      "meta.brace.round",
      "meta.brace.square",
      "keyword.operator.type.annotation",
      "meta.type storage.modifier.array",
    ],
    settings: {
      foreground: "#8b9798",
    },
  },
  {
    scope: "region.redish",
    settings: {
      foreground: "#ff6d7e",
    },
  },
  {
    scope: "region.orangish",
    settings: {
      foreground: "#ffb270",
    },
  },
  {
    scope: "region.yellowish",
    settings: {
      foreground: "#ffed72",
    },
  },
  {
    scope: "region.greenish",
    settings: {
      foreground: "#a2e57b",
    },
  },
  {
    scope: "region.bluish",
    settings: {
      foreground: "#7cd5f1",
    },
  },
  {
    scope: "region.purplish",
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: "region.pinkish",
    settings: {
      foreground: "#ff6d7e",
    },
  },
  {
    scope: "region.whitish",
    settings: {
      foreground: "#FFFFFF",
    },
  },
  {
    scope: "source",
    settings: {
      foreground: "#f2fffc",
    },
  },
  {
    scope: ["source.scss", "source.sass"],
    settings: {
      foreground: "#8b9798",
    },
  },
  {
    scope: [
      "source.sass variable.other",
      "source.sass variable.sass",
      "source.scss variable.other",
      "source.scss variable.scss",
      "source.scss variable.sass",
      "source.css variable.other",
      "source.css variable.scss",
      "source.less variable.other",
      "source.less variable.other.less",
      "source.less variable.declaration.less",
    ],
    settings: {
      foreground: "#ffb270",
      fontStyle: "italic",
    },
  },
  {
    scope: "source.git-show.commit.sha",
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: [
      "source.git-show.author",
      "source.git-show.date",
      "source.git-diff.command",
      "source.git-diff.command meta.diff.git-diff.header.from-file",
      "source.git-diff.command meta.diff.git-diff.header.to-file",
    ],
    settings: {
      foreground: "#8b9798",
    },
  },
  {
    scope: [
      "source.git-show meta.diff.git-diff.header.extended.index.from-sha",
      "source.git-show meta.diff.git-diff.header.extended.index.to-sha",
    ],
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: "source.git-show meta.diff.range.unified",
    settings: {
      foreground: "#ffb270",
    },
  },
  {
    scope: [
      "source.git-show meta.diff.header.from-file",
      "source.git-show meta.diff.header.to-file",
    ],
    settings: {
      foreground: "#8b9798",
    },
  },
  {
    scope: "storage",
    settings: {
      foreground: "#ff6d7e",
    },
  },
  {
    scope: "storage.type",
    settings: {
      foreground: "#7cd5f1",
      fontStyle: "italic",
    },
  },
  {
    scope: "storage.type.extends",
    settings: {
      foreground: "#ff6d7e",
    },
  },
  {
    scope: "storage.type.function.arrow",
    settings: {
      foreground: "#ff6d7e",
    },
  },
  {
    scope: ["storage.modifier", "storage.type.modifier"],
    settings: {
      foreground: "#ff6d7e",
      fontStyle: "italic",
    },
  },
  {
    scope: "storage.class.restructuredtext.ref",
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: ["storage.modifier.visibility.rust", "storage.modifier.lifetime.rust"],
    settings: {
      foreground: "#ff6d7e",
    },
  },
  {
    scope: [
      "storage.modifier.const.rust",
      "storage.modifier.dyn.rust",
      "storage.modifier.mut.rust",
      "storage.modifier.static.rust",
      "storage.type.rust",
      "storage.type.core.rust",
      "storage.class.std.rust",
    ],
    settings: {
      foreground: "#7cd5f1",
    },
  },
  {
    scope: [
      "storage.type.rust",
      "storage.modifier.const.rust",
      "storage.modifier.dyn.rust",
      "storage.modifier.mut.rust",
      "storage.modifier.static.rust",
      "keyword.other.rust",
      "keyword.other.where.rust",
    ],
    settings: {
      foreground: "#ff6d7e",
    },
  },
  {
    scope: "storage.modifier.import.java",
    settings: {
      foreground: "#f2fffc",
    },
  },
  {
    scope: "string",
    settings: {
      foreground: "#ffed72",
    },
  },
  {
    scope: "string.unquoted.label",
    settings: {
      foreground: "#f2fffc",
    },
  },
  {
    scope: "string source",
    settings: {
      foreground: "#f2fffc",
    },
  },
  {
    scope: [
      "string source punctuation.section.embedded",
      "string punctuation.definition.string source",
    ],
    settings: {
      foreground: "#8b9798",
    },
  },
  {
    scope: ["string.other.link.title", "string.other.link.description"],
    settings: {
      foreground: "#ff6d7e",
    },
  },
  {
    scope: "string.other.link.description.title",
    settings: {
      foreground: "#7cd5f1",
    },
  },
  {
    scope: [
      "string.regexp punctuation.definition.string.begin",
      "string.regexp punctuation.definition.string.end",
    ],
    settings: {
      foreground: "#ff6d7e",
    },
  },
  {
    scope: ["string.other.ref", "string.other.restructuredtext.ref"],
    settings: {
      foreground: "#a2e57b",
    },
  },
  {
    scope: "string.other.git-status.help.key",
    settings: {
      foreground: "#b8c4c3",
    },
  },
  {
    scope: "string.other.git-status.remote",
    settings: {
      foreground: "#ff6d7e",
    },
  },
  {
    scope: "support.constant",
    settings: {
      foreground: "#7cd5f1",
    },
  },
  {
    scope: "support.constant.handlebars",
    settings: {
      foreground: "#8b9798",
    },
  },
  {
    scope: "support.type.vendor-prefix.css",
    settings: {
      foreground: "#b8c4c3",
    },
  },
  {
    scope: "support.function",
    settings: {
      foreground: "#a2e57b",
    },
  },
  {
    scope: "support.macro",
    settings: {
      foreground: "#a2e57b",
    },
  },
  {
    scope: "support.function.delimiter.elm",
    settings: {
      foreground: "#8b9798",
    },
  },
  {
    scope: ["support.type", "entity.name.type.object.console"],
    settings: {
      foreground: "#7cd5f1",
      fontStyle: "italic",
    },
  },
  {
    scope: ["support.variable", "support.variable.property"],
    settings: {
      foreground: "#7cd5f1",
    },
  },
  {
    scope: "support.type.property-name",
    settings: {
      foreground: "#f2fffc",
    },
  },
  {
    scope: "support.class",
    settings: {
      foreground: "#7cd5f1",
    },
  },
  {
    scope: "support.constant.core.rust",
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: ["comment support", "comment support.class"],
    settings: {
      foreground: "#6b7678",
    },
  },
  {
    scope: "text",
    settings: {
      foreground: "#f2fffc",
    },
  },
  {
    scope: "text.find-in-files",
    settings: {
      foreground: "#f2fffc",
    },
  },
  {
    scope: ["variable", "variable.other"],
    settings: {
      foreground: "#f2fffc",
    },
  },
  {
    scope: ["variable.parameter", "parameters variable.function"],
    settings: {
      foreground: "#ffb270",
      fontStyle: "italic",
    },
  },
  {
    scope: [
      "variable.language",
      "variable.parameter.function.language.special.self.python",
      "variable.parameter.function.language.special.cls.python",
    ],
    settings: {
      foreground: "#b8c4c3",
      fontStyle: "italic",
    },
  },
  {
    scope: "variable.language.arguments",
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: "variable.other.class",
    settings: {
      foreground: "#7cd5f1",
    },
  },
  {
    scope: "variable.other.constant",
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: "variable.other.readwrite",
    settings: {
      foreground: "#f2fffc",
    },
  },
  {
    scope: "variable.other.member",
    settings: {
      foreground: "#f2fffc",
    },
  },
  {
    scope: "variable.other.enummember",
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: ["variable.other.property", "variable.other.property.static", "variable.other.event"],
    settings: {
      foreground: "#f2fffc",
    },
  },
  {
    scope: "variable.function",
    settings: {
      foreground: "#a2e57b",
    },
  },
  {
    scope: "variable.other.substitution",
    settings: {
      foreground: "#ffb270",
    },
  },
  {
    scope: [
      "source.ruby variable.other.readwrite.instance.ruby",
      "source.ruby variable.other.readwrite.class.ruby",
    ],
    settings: {
      foreground: "#baa0f8",
    },
  },
  {
    scope: "source.jinja2 variable.other.jinja2.block",
    settings: {
      foreground: "#a2e57b",
    },
  },
  {
    scope: "source.jinja2 variable.other.jinja2",
    settings: {
      foreground: "#ffb270",
    },
  },
] as const satisfies SyntaxTheme;
