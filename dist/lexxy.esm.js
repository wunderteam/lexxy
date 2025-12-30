import Prism from 'prismjs';
import 'prismjs/components/prism-clike';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-markup-templating';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-php';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-diff';
import DOMPurify from 'dompurify';
import { getStyleObjectFromCSS, getCSSFromStyleObject, $getSelectionStyleValueForProperty, $patchStyleText } from '@lexical/selection';
import { $isTextNode, TextNode, $isRangeSelection, $getSelection, DecoratorNode, $getNodeByKey, HISTORY_MERGE_TAG, FORMAT_TEXT_COMMAND, $createTextNode, UNDO_COMMAND, REDO_COMMAND, PASTE_COMMAND, COMMAND_PRIORITY_LOW, KEY_TAB_COMMAND, COMMAND_PRIORITY_NORMAL, OUTDENT_CONTENT_COMMAND, INDENT_CONTENT_COMMAND, $isNodeSelection, $getRoot, $isLineBreakNode, $isElementNode, KEY_ARROW_LEFT_COMMAND, KEY_ARROW_RIGHT_COMMAND, KEY_ARROW_UP_COMMAND, KEY_ARROW_DOWN_COMMAND, KEY_DELETE_COMMAND, KEY_BACKSPACE_COMMAND, SELECTION_CHANGE_COMMAND, $createNodeSelection, $setSelection, $createParagraphNode, KEY_ENTER_COMMAND, COMMAND_PRIORITY_HIGH, $isParagraphNode, $insertNodes, $createLineBreakNode, CLEAR_HISTORY_COMMAND, $addUpdateTag, SKIP_DOM_SELECTION_TAG, createEditor, BLUR_COMMAND, FOCUS_COMMAND, KEY_DOWN_COMMAND, KEY_SPACE_COMMAND } from 'lexical';
import { $isListNode, $isListItemNode, INSERT_UNORDERED_LIST_COMMAND, INSERT_ORDERED_LIST_COMMAND, $createListNode, ListNode, ListItemNode, registerList } from '@lexical/list';
import { $isQuoteNode, $isHeadingNode, $createQuoteNode, $createHeadingNode, QuoteNode, HeadingNode, registerRichText } from '@lexical/rich-text';
import { $isCodeNode, CodeNode, normalizeCodeLang, CodeHighlightNode, registerCodeHighlighting, CODE_LANGUAGE_FRIENDLY_NAME_MAP } from '@lexical/code';
import { $isLinkNode, $createAutoLinkNode, $toggleLink, $createLinkNode, LinkNode, AutoLinkNode } from '@lexical/link';
import { $getTableCellNodeFromLexicalNode, INSERT_TABLE_COMMAND, $insertTableRowAtSelection, $insertTableColumnAtSelection, $deleteTableRowAtSelection, $deleteTableColumnAtSelection, $findTableNode, TableNode, TableCellNode, TableRowNode, registerTablePlugin, registerTableSelectionObserver, setScrollableTablesActive, $getTableRowIndexFromTableCellNode, $getTableColumnIndexFromTableCellNode, $getElementForTableNode, $isTableCellNode, TableCellHeaderStates } from '@lexical/table';
import { $generateNodesFromDOM, $generateHtmlFromNodes } from '@lexical/html';
import { registerMarkdownShortcuts, TRANSFORMERS } from '@lexical/markdown';
import { createEmptyHistoryState, registerHistory } from '@lexical/history';
import { DirectUpload } from '@rails/activestorage';
import { marked } from 'marked';

// Configure Prism for manual highlighting mode
// This must be set before importing prismjs
window.Prism = window.Prism || {};
window.Prism.manual = true;

const ALLOWED_HTML_TAGS = [ "a", "action-text-attachment", "b", "blockquote", "br", "code", "em",
  "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "mark", "ol", "p", "pre", "q", "s", "strong", "ul", "table", "tbody", "tr", "th", "td" ];

const ALLOWED_HTML_ATTRIBUTES = [ "alt", "caption", "class", "content", "content-type", "contenteditable",
  "data-direct-upload-id", "data-sgid", "filename", "filesize", "height", "href", "presentation",
  "previewable", "sgid", "src", "style", "title", "url", "width" ];

const ALLOWED_STYLE_PROPERTIES = [ "color", "background-color" ];

function styleFilterHook(_currentNode, hookEvent) {
  if (hookEvent.attrName === "style" && hookEvent.attrValue) {
    const styles = { ...getStyleObjectFromCSS(hookEvent.attrValue) };
    const sanitizedStyles = { };

    for (const property in styles) {
      if (ALLOWED_STYLE_PROPERTIES.includes(property)) {
        sanitizedStyles[property] = styles[property];
      }
    }

    if (Object.keys(sanitizedStyles).length) {
      hookEvent.attrValue = getCSSFromStyleObject(sanitizedStyles);
    } else {
      hookEvent.keepAttr = false;
    }
  }
}

DOMPurify.addHook("uponSanitizeAttribute", styleFilterHook);

DOMPurify.addHook("uponSanitizeElement", (node, data) => {
  if (data.tagName === "strong" || data.tagName === "em") {
    node.removeAttribute("class");
  }
});

DOMPurify.setConfig({
  ALLOWED_TAGS: ALLOWED_HTML_TAGS,
  ALLOWED_ATTR: ALLOWED_HTML_ATTRIBUTES,
  SAFE_FOR_XML: false // So that it does not strip attributes that contains serialized HTML (like content)
});

function getNonce() {
  const element = document.head.querySelector("meta[name=csp-nonce]");
  return element?.content
}

function getNearestListItemNode(node) {
  let current = node;
  while (current !== null) {
    if ($isListItemNode(current)) return current
    current = current.getParent();
  }
  return null
}

function getListType(node) {
  let current = node;
  while (current) {
    if ($isListNode(current)) {
      return current.getListType()
    }
    current = current.getParent();
  }
  return null
}

function isPrintableCharacter(event) {
  // Ignore if modifier keys are pressed (except Shift for uppercase)
  if (event.ctrlKey || event.metaKey || event.altKey) return false

  // Ignore special keys
  if (event.key.length > 1 && event.key !== "Enter" && event.key !== "Space") return false

  // Accept single character keys (letters, numbers, punctuation)
  return event.key.length === 1
}

function extendTextNodeConversion(conversionName, callback = (textNode => textNode)) {
  return extendConversion(TextNode, conversionName, (conversionOutput, element) => ({
    ...conversionOutput,
    forChild: (lexicalNode, parentNode) => {
      const originalForChild = conversionOutput?.forChild ?? (x => x);
      let childNode = originalForChild(lexicalNode, parentNode);

      if ($isTextNode(childNode)) childNode = callback(childNode, element) ?? childNode;
      return childNode
    }
  }))
}

function extendConversion(nodeKlass, conversionName, callback = (output => output)) {
  return (element) => {
    const converter = nodeKlass.importDOM()?.[conversionName]?.(element);
    if (!converter) return null

    const conversionOutput = converter.conversion(element);
    if (!conversionOutput) return conversionOutput

    return callback(conversionOutput, element) ?? conversionOutput
  }
}

function isSelectionHighlighted(selection) {
  if (!$isRangeSelection(selection)) return false

  if (selection.isCollapsed()) {
    return hasHighlightStyles(selection.style)
  } else {
    return selection.hasFormat("highlight")
  }
}

function hasHighlightStyles(cssOrStyles) {
  const styles = typeof cssOrStyles === "string" ? getStyleObjectFromCSS(cssOrStyles) : cssOrStyles;
  return !!(styles.color || styles["background-color"])
}

class LexicalToolbarElement extends HTMLElement {
  static observedAttributes = [ "connected" ]

  constructor() {
    super();
    this.internals = this.attachInternals();
    this.internals.role = "toolbar";
  }

  connectedCallback() {
    requestAnimationFrame(() => this.#refreshToolbarOverflow());

    this._resizeObserver = new ResizeObserver(() => this.#refreshToolbarOverflow());
    this._resizeObserver.observe(this);
  }

  disconnectedCallback() {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    this.#unbindHotkeys();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name === "connected" && this.isConnected && oldValue != null && oldValue !== newValue) {
      requestAnimationFrame(() => this.#reconnect());
    }
  }

  setEditor(editorElement) {
    this.editorElement = editorElement;
    this.editor = editorElement.editor;
    this.#bindButtons();
    this.#bindHotkeys();
    this.#setTabIndexValues();
    this.#setItemPositionValues();
    this.#monitorSelectionChanges();
    this.#monitorHistoryChanges();
    this.#refreshToolbarOverflow();

    this.toggleAttribute("connected", true);
  }

  #reconnect() {
    this.disconnectedCallback();
    this.connectedCallback();
  }

  #bindButtons() {
    this.addEventListener("click", this.#handleButtonClicked.bind(this));
  }

  #handleButtonClicked({ target }) {
    this.#handleTargetClicked(target, "[data-command]", this.#dispatchButtonCommand.bind(this));
  }

  #handleTargetClicked(target, selector, callback) {
    const button = target.closest(selector);
    if (button) {
      callback(button);
    }
  }

  #dispatchButtonCommand(button) {
    const { command, payload } = button.dataset;
    this.editor.dispatchCommand(command, payload);
  }

  #bindHotkeys() {
    this.editorElement.addEventListener("keydown", this.#handleHotkey);
  }

  #unbindHotkeys() {
    this.editorElement?.removeEventListener("keydown", this.#handleHotkey);
  }

  #handleHotkey = (event) => {
    const buttons = this.querySelectorAll("[data-hotkey]");
    buttons.forEach((button) => {
      const hotkeys = button.dataset.hotkey.toLowerCase().split(/\s+/);
      if (hotkeys.includes(this.#keyCombinationFor(event))) {
        event.preventDefault();
        event.stopPropagation();
        button.click();
      }
    });
  }

  #keyCombinationFor(event) {
    const pressedKey = event.key.toLowerCase();
    const modifiers = [
      event.ctrlKey ? "ctrl" : null,
      event.metaKey ? "cmd" : null,
      event.altKey ? "alt" : null,
      event.shiftKey ? "shift" : null,
    ].filter(Boolean);

    return [ ...modifiers, pressedKey ].join("+")
  }

  #setTabIndexValues() {
    this.#buttons.forEach((button) => {
      button.setAttribute("tabindex", 0);
    });
  }

  #monitorSelectionChanges() {
    this.editor.registerUpdateListener(() => {
      this.editor.getEditorState().read(() => {
        this.#updateButtonStates();
      });
    });
  }

  #monitorHistoryChanges() {
    this.editor.registerUpdateListener(() => {
      this.#updateUndoRedoButtonStates();
    });
  }

  #updateUndoRedoButtonStates() {
    this.editor.getEditorState().read(() => {
      const historyState = this.editorElement.historyState;
      if (historyState) {
        this.#setButtonDisabled("undo", historyState.undoStack.length === 0);
        this.#setButtonDisabled("redo", historyState.redoStack.length === 0);
      }
    });
  }

  #updateButtonStates() {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return

    const anchorNode = selection.anchor.getNode();
    if (!anchorNode.getParent()) { return }

    const topLevelElement = anchorNode.getTopLevelElementOrThrow();

    const isBold = selection.hasFormat("bold");
    const isItalic = selection.hasFormat("italic");
    const isStrikethrough = selection.hasFormat("strikethrough");
    const isHighlight = isSelectionHighlighted(selection);
    const isInLink = this.#isInLink(anchorNode);
    const isInQuote = $isQuoteNode(topLevelElement);
    const isInHeading = $isHeadingNode(topLevelElement);
    const isInCode = $isCodeNode(topLevelElement) || selection.hasFormat("code");
    const isInList = this.#isInList(anchorNode);
    const listType = getListType(anchorNode);
    const isInTable = $getTableCellNodeFromLexicalNode(anchorNode) !== null;

    this.#setButtonPressed("bold", isBold);
    this.#setButtonPressed("italic", isItalic);
    this.#setButtonPressed("strikethrough", isStrikethrough);
    this.#setButtonPressed("highlight", isHighlight);
    this.#setButtonPressed("link", isInLink);
    this.#setButtonPressed("quote", isInQuote);
    this.#setButtonPressed("heading", isInHeading);
    this.#setButtonPressed("code", isInCode);
    this.#setButtonPressed("unordered-list", isInList && listType === "bullet");
    this.#setButtonPressed("ordered-list", isInList && listType === "number");
    this.#setButtonPressed("table", isInTable);

    this.#updateUndoRedoButtonStates();
  }

  #isInList(node) {
    let current = node;
    while (current) {
      if ($isListNode(current) || $isListItemNode(current)) return true
      current = current.getParent();
    }
    return false
  }

  #isInLink(node) {
    let current = node;
    while (current) {
      if ($isLinkNode(current)) return true
      current = current.getParent();
    }
    return false
  }

  #setButtonPressed(name, isPressed) {
    const button = this.querySelector(`[name="${name}"]`);
    if (button) {
      button.setAttribute("aria-pressed", isPressed.toString());
    }
  }

  #setButtonDisabled(name, isDisabled) {
    const button = this.querySelector(`[name="${name}"]`);
    if (button) {
      button.disabled = isDisabled;
      button.setAttribute("aria-disabled", isDisabled.toString());
    }
  }

  #toolbarIsOverflowing() {
    return this.scrollWidth > this.clientWidth
  }

  #refreshToolbarOverflow = () => {
    this.#resetToolbar();
    this.#compactMenu();

    this.#overflow.style.display = this.#overflowMenu.children.length ? "block" : "none";
    this.#overflow.setAttribute("nonce", getNonce());

    const isOverflowing = this.#overflowMenu.children.length > 0;
    this.toggleAttribute("overflowing", isOverflowing);
  }

  #compactMenu() {
    const buttons = this.#buttons.reverse();
    let movedToOverflow = false;

    for (const button of buttons) {
      if (this.#toolbarIsOverflowing()) {
        this.#overflowMenu.prepend(button);
        movedToOverflow = true;
      } else {
        if (movedToOverflow) this.#overflowMenu.prepend(button);
        break
      }
    }
  }

  #resetToolbar() {
    const items = Array.from(this.#overflowMenu.children);
    items.sort((a, b) => this.#itemPosition(b) - this.#itemPosition(a));

    items.forEach((item) => {
      const nextItem = this.querySelector(`[data-position="${this.#itemPosition(item) + 1}"]`) ?? this.#overflow;
      this.insertBefore(item, nextItem);
    });
  }

  #itemPosition(item) {
    return parseInt(item.dataset.position ?? "999")
  }

  #setItemPositionValues() {
    this.#toolbarItems.forEach((item, index) => {
      if (item.dataset.position === undefined) {
        item.dataset.position = index;
      }
    });
  }

  get #overflow() {
    return this.querySelector(".lexxy-editor__toolbar-overflow")
  }

  get #overflowMenu() {
    return this.querySelector(".lexxy-editor__toolbar-overflow-menu")
  }

  get #buttons() {
    return Array.from(this.querySelectorAll(":scope > button"))
  }

  get #toolbarItems() {
    return Array.from(this.querySelectorAll(":scope > *:not(.lexxy-editor__toolbar-overflow)"))
  }

  static get defaultTemplate() {
    return `
      <button class="lexxy-editor__toolbar-button" type="button" name="bold" data-command="bold" title="Bold">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M5 22V2h8.183c1.764 0 3.174.435 4.228 1.304 1.055.87 1.582 2.076 1.582 3.62 0 .8-.148 1.503-.445 2.109a3.94 3.94 0 01-1.194 1.465 4.866 4.866 0 01-1.726.806v.176c.786.078 1.51.312 2.172.703a4.293 4.293 0 011.596 1.627c.403.693.604 1.543.604 2.549 0 1.192-.292 2.207-.877 3.048-.585.84-1.39 1.484-2.416 1.934-1.026.44-2.206.659-3.538.659H5zM8.854 4.974v5.348h2.56c.873 0 1.582-.107 2.129-.322.556-.215.963-.523 1.222-.923.269-.41.403-.904.403-1.48 0-.82-.254-1.46-.762-1.92-.499-.468-1.204-.703-2.115-.703H8.854zm0 8.103v5.949h2.877c1.534 0 2.636-.245 3.307-.733.671-.498 1.007-1.221 1.007-2.168 0-.635-.134-1.178-.403-1.627-.268-.459-.666-.81-1.193-1.055-.518-.244-1.156-.366-1.913-.366H8.854z"/></svg>
      </button>

      <button class="lexxy-editor__toolbar-button" type="button" name="italic" data-command="italic" title="Italic">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M17.1 4h-1.5l-3.2 16h1.5l-.4 2h-7l.4-2h1.5l3.2-16h-1.5l.4-2h7l-.4 2z"/></svg>
      </button>

      <button class="lexxy-editor__toolbar-button" type="button" name="strikethrough" data-command="strikethrough" title="Strikethrough">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path fill-rule="evenodd" clip-rule="evenodd" d="M4.70588 16.1591C4.81459 19.7901 7.48035 22 11.6668 22C15.9854 22 18.724 19.6296 18.724 15.8779C18.724 15.5007 18.6993 15.1427 18.6474 14.8066H14.3721C14.8637 15.2085 15.0799 15.7037 15.0799 16.3471C15.0799 17.7668 13.7532 18.7984 11.8113 18.7984C9.88053 18.7984 8.38582 17.7531 8.21659 16.1591H4.70588ZM5.23953 9.31962H9.88794C9.10723 8.88889 8.75888 8.33882 8.75888 7.57339C8.75888 6.13992 9.96576 5.18793 11.7631 5.18793C13.5852 5.18793 14.8761 6.1797 14.9959 7.81344H18.4102C18.3485 4.31824 15.8038 2 11.752 2C7.867 2 5.09129 4.35802 5.09129 7.92044C5.09129 8.41838 5.14071 8.88477 5.23953 9.31962ZM2.23529 10.6914C1.90767 10.6914 1.59347 10.8359 1.36181 11.0931C1.13015 11.3504 1 11.6993 1 12.0631C1 12.4269 1.13015 12.7758 1.36181 13.0331C1.59347 13.2903 1.90767 13.4348 2.23529 13.4348H20.7647C21.0923 13.4348 21.4065 13.2903 21.6382 13.0331C21.8699 12.7758 22 12.4269 22 12.0631C22 11.6993 21.8699 11.3504 21.6382 11.0931C21.4065 10.8359 21.0923 10.6914 20.7647 10.6914H2.23529Z"/>
        </svg>
      </button>

      <details class="lexxy-editor__toolbar-dropdown" name="lexxy-dropdown">
        <summary class="lexxy-editor__toolbar-button" name="highlight" title="Color highlight">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.65422 0.711575C7.1856 0.242951 6.42579 0.242951 5.95717 0.711575C5.48853 1.18021 5.48853 1.94 5.95717 2.40864L8.70864 5.16011L2.85422 11.0145C1.44834 12.4204 1.44833 14.6998 2.85422 16.1057L7.86011 21.1115C9.26599 22.5174 11.5454 22.5174 12.9513 21.1115L19.6542 14.4087C20.1228 13.94 20.1228 13.1802 19.6542 12.7115L11.8544 4.91171L11.2542 4.31158L7.65422 0.711575ZM4.55127 12.7115L10.4057 6.85716L17.1087 13.56H4.19981C4.19981 13.253 4.31696 12.9459 4.55127 12.7115ZM23.6057 20.76C23.6057 22.0856 22.5311 23.16 21.2057 23.16C19.8802 23.16 18.8057 22.0856 18.8057 20.76C18.8057 19.5408 19.8212 18.5339 20.918 17.4462C21.0135 17.3516 21.1096 17.2563 21.2057 17.16C21.3018 17.2563 21.398 17.3516 21.4935 17.4462C22.5903 18.5339 23.6057 19.5408 23.6057 20.76Z"/></svg>
        </summary>
        <lexxy-highlight-dropdown class="lexxy-editor__toolbar-dropdown-content">
          <div data-button-group="color" data-values="var(--highlight-1); var(--highlight-2); var(--highlight-3); var(--highlight-4); var(--highlight-5); var(--highlight-6); var(--highlight-7); var(--highlight-8); var(--highlight-9)"></div>
          <div data-button-group="background-color" data-values="var(--highlight-bg-1); var(--highlight-bg-2); var(--highlight-bg-3); var(--highlight-bg-4); var(--highlight-bg-5); var(--highlight-bg-6); var(--highlight-bg-7); var(--highlight-bg-8); var(--highlight-bg-9)"></div>
          <button data-command="removeHighlight" class="lexxy-editor__toolbar-dropdown-reset">Remove all coloring</button>
        </lexxy-highlight-dropdown>
      </details>

      <details class="lexxy-editor__toolbar-dropdown" name="lexxy-dropdown">
        <summary class="lexxy-editor__toolbar-button" name="link" title="Link" data-hotkey="cmd+k ctrl+k">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12.111 9.546a1.5 1.5 0 012.121 0 5.5 5.5 0 010 7.778l-2.828 2.828a5.5 5.5 0 01-7.778 0 5.498 5.498 0 010-7.777l2.828-2.83a1.5 1.5 0 01.355-.262 6.52 6.52 0 00.351 3.799l-1.413 1.414a2.499 2.499 0 000 3.535 2.499 2.499 0 003.535 0l2.83-2.828a2.5 2.5 0 000-3.536 1.5 1.5 0 010-2.121z"/><path d="M12.111 3.89a5.5 5.5 0 117.778 7.777l-2.828 2.829a1.496 1.496 0 01-.355.262 6.522 6.522 0 00-.351-3.8l1.413-1.412a2.5 2.5 0 10-3.536-3.535l-2.828 2.828a2.5 2.5 0 000 3.536 1.5 1.5 0 01-2.122 2.12 5.5 5.5 0 010-7.777l2.83-2.829z"/></svg>
        </summary>
        <lexxy-link-dropdown class="lexxy-editor__toolbar-dropdown-content">
          <form method="dialog">
            <input type="url" placeholder="Enter a URL…" class="input">
            <div class="lexxy-editor__toolbar-dropdown-actions">
              <button type="submit" class="btn" value="link">Link</button>
              <button type="button" class="btn" value="unlink">Unlink</button>
            </div>
          </form>
        </lexxy-link-dropdown>
      </details>

      <button class="lexxy-editor__toolbar-button" type="button" name="quote" data-command="insertQuoteBlock" title="Quote">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M6.5 5C8.985 5 11 7.09 11 9.667c0 2.694-.962 5.005-2.187 6.644-.613.82-1.3 1.481-1.978 1.943-.668.454-1.375.746-2.022.746a.563.563 0 01-.52-.36.602.602 0 01.067-.57l.055-.066.009-.009.041-.048a4.25 4.25 0 00.168-.21c.143-.188.336-.47.53-.84a6.743 6.743 0 00.75-2.605C3.705 13.994 2 12.038 2 9.667 2 7.089 4.015 5 6.5 5zM17.5 5C19.985 5 22 7.09 22 9.667c0 2.694-.962 5.005-2.187 6.644-.613.82-1.3 1.481-1.978 1.943-.668.454-1.375.746-2.023.746a.563.563 0 01-.52-.36.602.602 0 01.068-.57l.055-.066.009-.009.041-.048c.039-.045.097-.115.168-.21a6.16 6.16 0 00.53-.84 6.745 6.745 0 00.75-2.605C14.705 13.994 13 12.038 13 9.667 13 7.089 15.015 5 17.5 5z"/></svg>
      </button>

      <button class="lexxy-editor__toolbar-button" type="button" name="heading" data-command="rotateHeadingFormat" title="Heading">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M15.322 5.315H9.64V22H5.684V5.315H0v-3.31h15.322v3.31z"/><path d="M23.957 11.79H19.92V22h-3.402V11.79H12.48V9.137h11.477v2.653z"/></svg>
      </button>

      <button class="lexxy-editor__toolbar-button" type="button" name="code" data-command="insertCodeBlock" title="Code">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M10.121 6l-6 6 6 6-2.12 2.121-7.061-7.06a1.5 1.5 0 010-2.121L8 3.879 10.121 6zM23.06 10.94a1.5 1.5 0 010 2.12L16 20.121 13.88 18l6-6-6-6L16 3.879l7.06 7.06z"/></svg>
      </button>

      <button class="lexxy-editor__toolbar-button" type="button" name="unordered-list" data-command="insertUnorderedList" title="Bullet list">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M5 5a2 2 0 11-4 0 2 2 0 014 0zM5 12a2 2 0 11-4 0 2 2 0 014 0zM5 19a2 2 0 11-4 0 2 2 0 014 0zM7 5.25C7 4.56 7.56 4 8.25 4h13.5a1.25 1.25 0 110 2.5H8.25C7.56 6.5 7 5.94 7 5.25zM7 12.25c0-.69.56-1.25 1.25-1.25h13.5a1.25 1.25 0 110 2.5H8.25c-.69 0-1.25-.56-1.25-1.25zM7 19.25c0-.69.56-1.25 1.25-1.25h13.5a1.25 1.25 0 110 2.5H8.25c-.69 0-1.25-.56-1.25-1.25z"/></svg>
      </button>

      <button class="lexxy-editor__toolbar-button" type="button" name="ordered-list" data-command="insertOrderedList" title="Numbered list">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M7 5.25C7 4.56 7.56 4 8.25 4h13.5a1.25 1.25 0 110 2.5H8.25C7.56 6.5 7 5.94 7 5.25zM7 12.25c0-.69.56-1.25 1.25-1.25h13.5a1.25 1.25 0 110 2.5H8.25c-.69 0-1.25-.56-1.25-1.25zM7 19.25c0-.69.56-1.25 1.25-1.25h13.5a1.25 1.25 0 110 2.5H8.25c-.69 0-1.25-.56-1.25-1.25zM4.438 8H3.39V3.684H3.34c-.133.093-.267.188-.402.285l-.407.289a129.5 129.5 0 00-.402.285v-.969l.633-.453c.21-.15.42-.302.629-.453h1.046V8zM2.672 11.258h-1v-.051c0-.206.036-.405.11-.598.075-.195.188-.37.34-.527.15-.156.339-.281.566-.375.229-.094.498-.14.808-.14.367 0 .688.065.961.195s.484.308.633.535c.15.224.226.478.226.762 0 .244-.046.463-.14.656-.091.19-.209.368-.352.535-.14.164-.289.332-.445.504L3.168 14.09v.05h2.238V15H1.723v-.656l1.949-2.102c.096-.101.19-.207.281-.316.091-.112.167-.232.227-.36a.953.953 0 00.09-.41.712.712 0 00-.387-.648.845.845 0 00-.41-.098.81.81 0 00-.43.11.75.75 0 00-.277.293.824.824 0 00-.094.386V11.258zM2.852 19.66v-.812h.562a.917.917 0 00.43-.098.742.742 0 00.293-.266.673.673 0 00.101-.379.654.654 0 00-.234-.523.87.87 0 00-.59-.2.987.987 0 00-.336.055.837.837 0 00-.258.149.712.712 0 00-.172.215.66.66 0 00-.066.25h-.98c.007-.209.053-.403.136-.582.084-.18.203-.336.36-.469.156-.135.346-.24.57-.316.227-.076.486-.115.777-.118a2.33 2.33 0 01.965.176c.271.12.48.285.63.496.15.209.227.448.23.719a1.11 1.11 0 01-.16.637 1.28 1.28 0 01-.825.586v.054c.162.016.33.07.504.164.177.094.328.232.453.415.125.18.189.411.192.695a1.37 1.37 0 01-.157.676c-.104.197-.25.365-.437.503-.188.136-.404.24-.649.313-.242.07-.5.105-.777.105-.401 0-.743-.067-1.027-.203a1.608 1.608 0 01-.649-.547 1.46 1.46 0 01-.238-.75h.969c.01.128.057.243.14.344a.885.885 0 00.332.238c.141.058.3.088.477.09.195 0 .366-.034.512-.101a.798.798 0 00.336-.29.744.744 0 00.117-.425.74.74 0 00-.446-.695 1.082 1.082 0 00-.496-.106h-.59z"/></svg>
      </button>

      <button class="lexxy-editor__toolbar-button" type="button" name="upload" data-command="uploadAttachments" title="Upload file">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M16 8a2 2 0 110 4 2 2 0 010-4z""/><path d="M22 2a1 1 0 011 1v18a1 1 0 01-1 1H2a1 1 0 01-1-1V3a1 1 0 011-1h20zM3 18.714L9 11l5.25 6.75L17 15l4 4V4H3v14.714z"/></svg>
      </button>

      <button class="lexxy-editor__toolbar-button" type="button" name="table" data-command="insertTable" title="Insert a table">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20.2041 2.01074C21.2128 2.113 22 2.96435 22 4V20L21.9893 20.2041C21.8938 21.1457 21.1457 21.8938 20.2041 21.9893L20 22H4C2.96435 22 2.113 21.2128 2.01074 20.2041L2 20V4C2 2.89543 2.89543 2 4 2H20L20.2041 2.01074ZM4 13V20H11V13H4ZM13 13V20H20V13H13ZM4 11H11V4H4V11ZM13 11H20V4H13V11Z"/></svg>
      </button>

      <button class="lexxy-editor__toolbar-button" type="button" name="divider" data-command="insertHorizontalDivider" title="Insert a divider">
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M0 12C0 11.4477 0.447715 11 1 11H23C23.5523 11 24 11.4477 24 12C24 12.5523 23.5523 13 23 13H1C0.447716 13 0 12.5523 0 12Z"/><path d="M4 5C4 3.89543 4.89543 3 6 3H18C19.1046 3 20 3.89543 20 5C20 6.10457 19.1046 7 18 7H6C4.89543 7 4 6.10457 4 5Z"/><path d="M4 19C4 17.8954 4.89543 17 6 17H18C19.1046 17 20 17.8954 20 19C20 20.1046 19.1046 21 18 21H6C4.89543 21 4 20.1046 4 19Z"/></svg>
      </button>
 
      <div class="lexxy-editor__toolbar-spacer" role="separator"></div>
 
      <button class="lexxy-editor__toolbar-button" type="button" name="undo" data-command="undo" title="Undo" data-hotkey="cmd+z ctrl+z">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M5.64648 8.26531C7.93911 6.56386 10.7827 5.77629 13.624 6.05535C16.4655 6.33452 19.1018 7.66079 21.0195 9.77605C22.5839 11.5016 23.5799 13.6516 23.8936 15.9352C24.0115 16.7939 23.2974 17.4997 22.4307 17.4997C21.5641 17.4997 20.8766 16.7915 20.7148 15.9401C20.4295 14.4379 19.7348 13.0321 18.6943 11.8844C17.3 10.3464 15.3835 9.38139 13.3174 9.17839C11.2514 8.97546 9.18359 9.54856 7.5166 10.7858C6.38259 11.6275 5.48981 12.7361 4.90723 13.9997H8.5C9.3283 13.9997 9.99979 14.6714 10 15.4997C10 16.3281 9.32843 16.9997 8.5 16.9997H1.5C0.671573 16.9997 0 16.3281 0 15.4997V8.49968C0.000213656 7.67144 0.671705 6.99968 1.5 6.99968C2.3283 6.99968 2.99979 7.67144 3 8.49968V11.0212C3.7166 9.9704 4.60793 9.03613 5.64648 8.26531Z"/></svg>
      </button>

      <button class="lexxy-editor__toolbar-button" type="button" name="redo" data-command="redo" title="Redo" data-hotkey="cmd+shift+z ctrl+shift+z ctrl+y">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M18.2599 8.26531C15.9672 6.56386 13.1237 5.77629 10.2823 6.05535C7.4408 6.33452 4.80455 7.66079 2.88681 9.77605C1.32245 11.5016 0.326407 13.6516 0.0127834 15.9352C-0.105117 16.7939 0.608975 17.4997 1.47567 17.4997C2.34228 17.4997 3.02969 16.7915 3.19149 15.9401C3.47682 14.4379 4.17156 13.0321 5.212 11.8844C6.60637 10.3464 8.52287 9.38139 10.589 9.17839C12.655 8.97546 14.7227 9.54856 16.3897 10.7858C17.5237 11.6275 18.4165 12.7361 18.9991 13.9997H15.4063C14.578 13.9997 13.9066 14.6714 13.9063 15.4997C13.9063 16.3281 14.5779 16.9997 15.4063 16.9997H22.4063C23.2348 16.9997 23.9063 16.3281 23.9063 15.4997V8.49968C23.9061 7.67144 23.2346 6.99968 22.4063 6.99968C21.578 6.99968 20.9066 7.67144 20.9063 8.49968V11.0212C20.1897 9.9704 19.2984 9.03613 18.2599 8.26531Z"/></svg>
      </button>

      <details class="lexxy-editor__toolbar-overflow">
        <summary class="lexxy-editor__toolbar-button" aria-label="Show more toolbar buttons">•••</summary>
        <div class="lexxy-editor__toolbar-overflow-menu" aria-label="More toolbar buttons"></div>
      </details>
    `
  }
}

customElements.define("lexxy-toolbar", LexicalToolbarElement);

var theme = {
  text: {
    bold: "lexxy-content__bold",
    italic: "lexxy-content__italic",
    strikethrough: "lexxy-content__strikethrough",
    underline: "lexxy-content__underline",
    highlight: "lexxy-content__highlight"
  },
  tableCellHeader: "lexxy-content__table-cell--header",
  tableCellSelected: "lexxy-content__table-cell--selected",
  tableSelection: "lexxy-content__table--selection",
  tableScrollableWrapper: "lexxy-content__table-wrapper",
  list: {
    nested: {
      listitem: "lexxy-nested-listitem",
    }
  },
  codeHighlight: {
    addition: "code-token__selector",
    atrule: "code-token__attr",
    attr: "code-token__attr",
    "attr-name": "code-token__attr",
    "attr-value": "code-token__selector",
    boolean: "code-token__property",
    bold: "code-token__variable",
    builtin: "code-token__selector",
    cdata: "code-token__comment",
    char: "code-token__selector",
    class: "code-token__function",
    "class-name": "code-token__function",
    color: "code-token__property",
    comment: "code-token__comment",
    constant: "code-token__property",
    coord: "code-token__comment",
    decorator: "code-token__function",
    deleted: "code-token__operator",
    deletion: "code-token__operator",
    directive: "code-token__attr",
    "directive-hash": "code-token__property",
    doctype: "code-token__comment",
    entity: "code-token__operator",
    function: "code-token__function",
    hexcode: "code-token__property",
    important: "code-token__function",
    inserted: "code-token__selector",
    italic: "code-token__comment",
    keyword: "code-token__attr",
    line: "code-token__selector",
    namespace: "code-token__variable",
    number: "code-token__property",
    macro: "code-token__function",
    operator: "code-token__operator",
    parameter: "code-token__variable",
    prolog: "code-token__comment",
    property: "code-token__property",
    punctuation: "code-token__punctuation",
    "raw-string": "code-token__operator",
    regex: "code-token__variable",
    script: "code-token__function",
    selector: "code-token__selector",
    string: "code-token__selector",
    style: "code-token__function",
    symbol: "code-token__property",
    tag: "code-token__property",
    title: "code-token__function",
    "type-definition": "code-token__function",
    url: "code-token__operator",
    variable: "code-token__variable",
  }
};

function createElement(name, properties, content = "") {
  const element = document.createElement(name);
  for (const [ key, value ] of Object.entries(properties || {})) {
    if (key in element) {
      element[key] = value;
    } else if (value !== null && value !== undefined) {
      element.setAttribute(key, value);
    }
  }
  if (content) {
    element.innerHTML = content;
  }
  return element
}

function parseHtml(html) {
  const parser = new DOMParser();
  return parser.parseFromString(html, "text/html")
}

function createAttachmentFigure(contentType, isPreviewable, fileName) {
  const extension = fileName ? fileName.split(".").pop().toLowerCase() : "unknown";
  return createElement("figure", {
    className: `attachment attachment--${isPreviewable ? "preview" : "file"} attachment--${extension}`,
    "data-content-type": contentType
  })
}

function isPreviewableImage(contentType) {
  return contentType.startsWith("image/") && !contentType.includes("svg")
}

function dispatchCustomEvent(element, name, detail) {
  const event = new CustomEvent(name, {
    detail: detail,
    bubbles: true,
  });
  element.dispatchEvent(event);
}

function sanitize(html) {
  return DOMPurify.sanitize(html)
}

function dispatch(element, eventName, detail = null, cancelable = false) {
  return element.dispatchEvent(new CustomEvent(eventName, { bubbles: true, detail, cancelable }))
}

function generateDomId(prefix) {
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${randomPart}`
}

function bytesToHumanSize(bytes) {
  if (bytes === 0) return "0 B"
  const sizes = [ "B", "KB", "MB", "GB", "TB", "PB" ];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${ value.toFixed(2) } ${ sizes[i] }`
}

class ActionTextAttachmentNode extends DecoratorNode {
  static getType() {
    return "action_text_attachment"
  }

  static clone(node) {
    return new ActionTextAttachmentNode({ ...node }, node.__key)
  }

  static importJSON(serializedNode) {
    return new ActionTextAttachmentNode({ ...serializedNode })
  }

  static importDOM() {
    return {
      "action-text-attachment": (attachment) => {
        return {
          conversion: () => ({
            node: new ActionTextAttachmentNode({
              sgid: attachment.getAttribute("sgid"),
              src: attachment.getAttribute("url"),
              previewable: attachment.getAttribute("previewable"),
              altText: attachment.getAttribute("alt"),
              caption: attachment.getAttribute("caption"),
              contentType: attachment.getAttribute("content-type"),
              fileName: attachment.getAttribute("filename"),
              fileSize: attachment.getAttribute("filesize"),
              width: attachment.getAttribute("width"),
              height: attachment.getAttribute("height")
            })
          }),
          priority: 1
        }
      },
      "img": (img) => {
        return {
          conversion: () => ({
            node: new ActionTextAttachmentNode({
              src: img.getAttribute("src"),
              caption: img.getAttribute("alt") || "",
              contentType: "image/*",
              width: img.getAttribute("width"),
              height: img.getAttribute("height")
            })
          }),
          priority: 1
        }
      },
      "video": (video) => {
        const videoSource = video.getAttribute("src") || video.querySelector("source")?.src;
        const fileName = videoSource?.split("/")?.pop();
        const contentType = video.querySelector("source")?.getAttribute("content-type") || "video/*";

        return {
          conversion: () => ({
            node: new ActionTextAttachmentNode({
              src: videoSource,
              fileName: fileName,
              contentType: contentType
            })
          }),
          priority: 1
        }
      }
    }
  }

  constructor({ sgid, src, previewable, altText, caption, contentType, fileName, fileSize, width, height }, key) {
    super(key);

    this.sgid = sgid;
    this.src = src;
    this.previewable = previewable;
    this.altText = altText || "";
    this.caption = caption || "";
    this.contentType = contentType || "";
    this.fileName = fileName || "";
    this.fileSize = fileSize;
    this.width = width;
    this.height = height;
  }

  createDOM() {
    const figure = this.createAttachmentFigure();

    figure.addEventListener("click", (event) => {
      this.#select(figure);
    });

    if (this.isPreviewableAttachment) {
      figure.appendChild(this.#createDOMForImage());
      figure.appendChild(this.#createEditableCaption());
    } else {
      figure.appendChild(this.#createDOMForFile());
      figure.appendChild(this.#createDOMForNotImage());
    }

    return figure
  }

  updateDOM() {
    return true
  }

  getTextContent() {
    return `[${ this.caption || this.fileName }]\n\n`
  }

  isInline() {
    return false
  }

  exportDOM() {
    const attachment = createElement("action-text-attachment", {
      sgid: this.sgid,
      previewable: this.previewable || null,
      url: this.src,
      alt: this.altText,
      caption: this.caption,
      "content-type": this.contentType,
      filename: this.fileName,
      filesize: this.fileSize,
      width: this.width,
      height: this.height,
      presentation: "gallery"
    });

    return { element: attachment }
  }

  exportJSON() {
    return {
      type: "action_text_attachment",
      version: 1,
      sgid: this.sgid,
      src: this.src,
      previewable: this.previewable,
      altText: this.altText,
      caption: this.caption,
      contentType: this.contentType,
      fileName: this.fileName,
      fileSize: this.fileSize,
      width: this.width,
      height: this.height
    }
  }

  decorate() {
    return null
  }

  createAttachmentFigure() {
    return createAttachmentFigure(this.contentType, this.isPreviewableAttachment, this.fileName)
  }

  get #isPreviewableImage() {
    return isPreviewableImage(this.contentType)
  }

  get isPreviewableAttachment() {
    return this.#isPreviewableImage || this.previewable
  }

  #createDOMForImage() {
    return createElement("img", { src: this.src, alt: this.altText, ...this.#imageDimensions })
  }

  get #imageDimensions() {
    if (this.width && this.height) {
      return { width: this.width, height: this.height }
    } else {
      return {}
    }
  }

  #createDOMForFile() {
    const extension = this.fileName ? this.fileName.split(".").pop().toLowerCase() : "unknown";
    return createElement("span", { className: "attachment__icon", textContent: `${extension}` })
  }

  #createDOMForNotImage() {
    const figcaption = createElement("figcaption", { className: "attachment__caption" });

    const nameTag = createElement("strong", { className: "attachment__name", textContent: this.caption || this.fileName });

    figcaption.appendChild(nameTag);

    if (this.fileSize) {
      const sizeSpan = createElement("span", { className: "attachment__size", textContent: bytesToHumanSize(this.fileSize) });
      figcaption.appendChild(sizeSpan);
    }

    return figcaption
  }

  #select(figure) {
    dispatchCustomEvent(figure, "lexxy:internal:select-node", { key: this.getKey() });
  }

  #createEditableCaption() {
    const caption = createElement("figcaption", { className: "attachment__caption" });
    const input = createElement("textarea", {
      value: this.caption,
      placeholder: this.fileName,
      rows: "1"
    });

    input.addEventListener("focusin", () => input.placeholder = "Add caption...");
    input.addEventListener("blur", this.#handleCaptionInputBlurred.bind(this));
    input.addEventListener("keydown", this.#handleCaptionInputKeydown.bind(this));

    caption.appendChild(input);

    return caption
  }

  #handleCaptionInputBlurred(event) {
    const input = event.target;

    input.placeholder = this.fileName;
    this.#updateCaptionValueFromInput(input);
  }

  #updateCaptionValueFromInput(input) {
    dispatchCustomEvent(input, "lexxy:internal:invalidate-node", { key: this.getKey(), values: { caption: input.value } });
  }

  #handleCaptionInputKeydown(event) {
    if (event.key === "Enter") {
      this.#updateCaptionValueFromInput(event.target);
      dispatchCustomEvent(event.target, "lexxy:internal:move-to-next-line");
      event.preventDefault();
    }
    event.stopPropagation();
  }
}

async function loadFileIntoImage(file, image) {
  return new Promise((resolve) => {
    const reader = new FileReader();

    image.addEventListener("load", () => {
      resolve(image);
    });

    reader.onload = (event) => {
      image.src = event.target.result || null;
    };

    reader.readAsDataURL(file);
  })
}

class ActionTextAttachmentUploadNode extends ActionTextAttachmentNode {
  static getType() {
    return "action_text_attachment_upload"
  }

  static clone(node) {
    return new ActionTextAttachmentUploadNode({ ...node }, node.__key)
  }

  static importJSON(serializedNode) {
    return new ActionTextAttachmentUploadNode({ ...serializedNode })
  }

  // Should never run since this is a transient node. Defined to remove console warning.
  static importDOM() {
    return null
  }

  constructor({ file, uploadUrl, blobUrlTemplate, editor, progress }, key) {
    super({ contentType: file.type }, key);
    this.file = file;
    this.uploadUrl = uploadUrl;
    this.blobUrlTemplate = blobUrlTemplate;
    this.src = null;
    this.editor = editor;
    this.progress = progress || 0;
  }

  createDOM() {
    const figure = this.createAttachmentFigure();

    if (this.isPreviewableAttachment) {
      figure.appendChild(this.#createDOMForImage());
    } else {
      figure.appendChild(this.#createDOMForFile());
    }

    figure.appendChild(this.#createCaption());

    const progressBar = createElement("progress", { value: this.progress, max: 100 });
    figure.appendChild(progressBar);

    // We wait for images to download so that we can pass the dimensions down to the attachment. We do this
    // so that we can render images in edit mode with the dimensions set, which prevent vertical layout shifts.
    this.#loadFigure(figure).then(() => this.#startUpload(progressBar, figure));

    return figure
  }

  exportDOM() {
    const img = document.createElement("img");
    if (this.src) {
      img.src = this.src;
    }
    return { element: img }
  }

  exportJSON() {
    return {
      type: "action_text_attachment_upload",
      version: 1,
      progress: this.progress,
      uploadUrl: this.uploadUrl,
      blobUrlTemplate: this.blobUrlTemplate,
      ...super.exportJSON()
    }
  }

  #createDOMForImage() {
    return createElement("img")
  }

  #createDOMForFile() {
    const extension = this.#getFileExtension();
    const span = createElement("span", { className: "attachment__icon", textContent: extension });
    return span
  }

  #getFileExtension() {
    return this.file.name.split(".").pop().toLowerCase()
  }

  #createCaption() {
    const figcaption = createElement("figcaption", { className: "attachment__caption" });

    const nameSpan = createElement("span", { className: "attachment__name", textContent: this.file.name || "" });
    const sizeSpan = createElement("span", { className: "attachment__size", textContent: bytesToHumanSize(this.file.size) });
    figcaption.appendChild(nameSpan);
    figcaption.appendChild(sizeSpan);

    return figcaption
  }

  #loadFigure(figure) {
    const image = figure.querySelector("img");
    if (!image) {
      return Promise.resolve()
    } else {
      return loadFileIntoImage(this.file, image)
    }
  }

  #startUpload(progressBar, figure) {
    const upload = new DirectUpload(this.file, this.uploadUrl, this);

    upload.delegate = {
      directUploadWillStoreFileWithXHR: (request) => {
        request.upload.addEventListener("progress", (event) => {
          this.editor.update(() => {
            progressBar.value = Math.round(event.loaded / event.total * 100);
          });
        });
      }
    };

    upload.create((error, blob) => {
      if (error) {
        this.#handleUploadError(figure);
      } else {
        this.#loadFigurePreviewFromBlob(blob, figure).then(() => {
          this.#showUploadedAttachment(figure, blob);
        });
      }
    });
  }

  #handleUploadError(figure) {
    figure.innerHTML = "";
    figure.classList.add("attachment--error");
    figure.appendChild(createElement("div", { innerText: `Error uploading ${this.file?.name ?? "image"}` }));
  }

  async #showUploadedAttachment(figure, blob) {
    this.editor.update(() => {
      const image = figure.querySelector("img");

      const src = this.blobUrlTemplate
                    .replace(":signed_id", blob.signed_id)
                    .replace(":filename", encodeURIComponent(blob.filename));
      const latest = $getNodeByKey(this.getKey());
      if (latest) {
        latest.replace(new ActionTextAttachmentNode({
          sgid: blob.attachable_sgid,
          src: blob.previewable ? blob.url : src,
          altText: blob.filename,
          contentType: blob.content_type,
          fileName: blob.filename,
          fileSize: blob.byte_size,
          width: image?.naturalWidth,
          previewable: blob.previewable,
          height: image?.naturalHeight
        }));
      }
    }, { tag: HISTORY_MERGE_TAG });
  }

  async #loadFigurePreviewFromBlob(blob, figure) {
    if (blob.previewable) {
      return new Promise((resolve) => {
        this.editor.update(() => {
          const image = this.#createDOMForImage();
          image.addEventListener("load", () => {
            resolve();
          });
          image.src = blob.url;
          figure.insertBefore(image, figure.firstChild);
        });
      })
    } else {
      return Promise.resolve()
    }
  }
}

class HorizontalDividerNode extends DecoratorNode {
  static getType() {
    return "horizontal_divider"
  }

  static clone(node) {
    return new HorizontalDividerNode(node.__key)
  }

  static importJSON(serializedNode) {
    return new HorizontalDividerNode()
  }

  static importDOM() {
    return {
      "hr": (hr) => {
        return {
          conversion: () => ({
            node: new HorizontalDividerNode()
          }),
          priority: 1
        }
      }
    }
  }

  constructor(key) {
    super(key);
  }

  createDOM() {
    const figure = createElement("figure", { className: "horizontal-divider" });
    const hr = createElement("hr");

    figure.addEventListener("click", (event) => {
      dispatchCustomEvent(figure, "lexxy:internal:select-node", { key: this.getKey() });
    });

    figure.appendChild(hr);

    return figure
  }

  updateDOM() {
    return true
  }

  getTextContent() {
    return "┄\n\n"
  }

  isInline() {
    return false
  }

  exportDOM() {
    const hr = createElement("hr");
    return { element: hr }
  }

  exportJSON() {
    return {
      type: "horizontal_divider",
      version: 1
    }
  }

  decorate() {
    return null
  }
}

const COMMANDS = [
  "bold",
  "italic",
  "strikethrough",
  "link",
  "unlink",
  "toggleHighlight",
  "removeHighlight",
  "rotateHeadingFormat",
  "insertUnorderedList",
  "insertOrderedList",
  "insertQuoteBlock",
  "insertCodeBlock",
  "insertHorizontalDivider",
  "uploadAttachments",

  "insertTable",
  "insertTableRowAbove",
  "insertTableRowBelow",
  "insertTableColumnAfter",
  "insertTableColumnBefore",
  "deleteTableRow",
  "deleteTableColumn",
  "deleteTable",

  "undo",
  "redo"
];

class CommandDispatcher {
  static configureFor(editorElement) {
    new CommandDispatcher(editorElement);
  }

  constructor(editorElement) {
    this.editorElement = editorElement;
    this.editor = editorElement.editor;
    this.selection = editorElement.selection;
    this.contents = editorElement.contents;
    this.clipboard = editorElement.clipboard;
    this.highlighter = editorElement.highlighter;

    this.#registerCommands();
    this.#registerKeyboardCommands();
    this.#registerDragAndDropHandlers();
  }

  dispatchPaste(event) {
    return this.clipboard.paste(event)
  }

  dispatchBold() {
    this.editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold");
  }

  dispatchItalic() {
    this.editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic");
  }

  dispatchStrikethrough() {
    this.editor.dispatchCommand(FORMAT_TEXT_COMMAND, "strikethrough");
  }

  dispatchToggleHighlight(styles) {
    this.highlighter.toggle(styles);
  }

  dispatchRemoveHighlight() {
    this.highlighter.remove();
  }

  dispatchLink(url) {
    this.editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return

      if (selection.isCollapsed()) {
        const autoLinkNode = $createAutoLinkNode(url);
        const textNode = $createTextNode(url);
        autoLinkNode.append(textNode);
        selection.insertNodes([ autoLinkNode ]);
      } else {
        $toggleLink(url);
      }
    });
  }

  dispatchUnlink() {
    this.#toggleLink(null);
  }

  dispatchInsertUnorderedList() {
    const selection = $getSelection();
    if (!selection) return

    const anchorNode = selection.anchor.getNode();

    if (this.selection.isInsideList && anchorNode && getListType(anchorNode) === "bullet") {
      this.contents.unwrapSelectedListItems();
    } else {
      this.editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
    }
  }

  dispatchInsertOrderedList() {
    const selection = $getSelection();
    if (!selection) return

    const anchorNode = selection.anchor.getNode();

    if (this.selection.isInsideList && anchorNode && getListType(anchorNode) === "number") {
      this.contents.unwrapSelectedListItems();
    } else {
      this.editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
    }
  }

  dispatchInsertQuoteBlock() {
    this.contents.toggleNodeWrappingAllSelectedNodes((node) => $isQuoteNode(node), () => $createQuoteNode());
  }

  dispatchInsertCodeBlock() {
    this.editor.update(() => {
      if (this.selection.hasSelectedWordsInSingleLine) {
        this.editor.dispatchCommand(FORMAT_TEXT_COMMAND, "code");
      } else {
        this.contents.toggleNodeWrappingAllSelectedLines((node) => $isCodeNode(node), () => new CodeNode("plain"));
      }
    });
  }

  dispatchInsertHorizontalDivider() {
    this.editor.update(() => {
      this.contents.insertAtCursorEnsuringLineBelow(new HorizontalDividerNode());
    });

    this.editor.focus();
  }

  dispatchRotateHeadingFormat() {
    this.editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return

      const topLevelElement = selection.anchor.getNode().getTopLevelElementOrThrow();
      let nextTag = "h2";
      if ($isHeadingNode(topLevelElement)) {
        const currentTag = topLevelElement.getTag();
        if (currentTag === "h2") {
          nextTag = "h3";
        } else if (currentTag === "h3") {
          nextTag = "h4";
        } else if (currentTag === "h4") {
          nextTag = null;
        } else {
          nextTag = "h2";
        }
      }

      if (nextTag) {
        this.contents.insertNodeWrappingEachSelectedLine(() => $createHeadingNode(nextTag));
      } else {
        this.contents.removeFormattingFromSelectedLines();
      }
    });
  }

  dispatchUploadAttachments() {
    const input = createElement("input", {
      type: "file",
      multiple: true,
      style: "display: none;",
      onchange: ({ target }) => {
        const files = Array.from(target.files);
        if (!files.length) return

        for (const file of files) {
          this.contents.uploadFile(file);
        }
      }
    });

    this.editorElement.appendChild(input); // Append and remove just for the sake of making it testable
    input.click();
    setTimeout(() => input.remove(), 1000);
  }

  dispatchInsertTable() {
    this.editor.dispatchCommand(INSERT_TABLE_COMMAND, { "rows": 3, "columns": 3, "includeHeaders": true });
  }

  dispatchInsertTableRowBelow() {
    $insertTableRowAtSelection(true);
  }

  dispatchInsertTableRowAbove() {
    $insertTableRowAtSelection(false);
  }

  dispatchInsertTableColumnAfter() {
    $insertTableColumnAtSelection(true);
  }

  dispatchInsertTableColumnBefore() {
    $insertTableColumnAtSelection(false);
  }

  dispatchDeleteTableRow() {
    $deleteTableRowAtSelection();
  }

  dispatchDeleteTableColumn() {
    $deleteTableColumnAtSelection();
  }

  dispatchDeleteTable() {
    this.editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return

      const anchorNode = selection.anchor.getNode();
      const tableNode = $findTableNode(anchorNode);
      tableNode.remove();
    });
  }

  dispatchUndo() {
    this.editor.dispatchCommand(UNDO_COMMAND, undefined);
  }

  dispatchRedo() {
    this.editor.dispatchCommand(REDO_COMMAND, undefined);
  }

  #registerCommands() {
    for (const command of COMMANDS) {
      const methodName = `dispatch${capitalize(command)}`;
      this.#registerCommandHandler(command, 0, this[methodName].bind(this));
    }

    this.#registerCommandHandler(PASTE_COMMAND, COMMAND_PRIORITY_LOW, this.dispatchPaste.bind(this));
  }

  #registerCommandHandler(command, priority, handler) {
    this.editor.registerCommand(command, handler, priority);
  }

  #registerKeyboardCommands() {
    this.editor.registerCommand(KEY_TAB_COMMAND, this.#handleListIndentation.bind(this), COMMAND_PRIORITY_NORMAL);
  }

  #registerDragAndDropHandlers() {
    if (this.editorElement.supportsAttachments) {
      this.dragCounter = 0;
      this.editor.getRootElement().addEventListener("dragover", this.#handleDragOver.bind(this));
      this.editor.getRootElement().addEventListener("drop", this.#handleDrop.bind(this));
      this.editor.getRootElement().addEventListener("dragenter", this.#handleDragEnter.bind(this));
      this.editor.getRootElement().addEventListener("dragleave", this.#handleDragLeave.bind(this));
    }
  }

  #handleDragEnter(event) {
    this.dragCounter++;
    if (this.dragCounter === 1) {
      this.editor.getRootElement().classList.add("lexxy-editor--drag-over");
    }
  }

  #handleDragLeave(event) {
    this.dragCounter--;
    if (this.dragCounter === 0) {
      this.editor.getRootElement().classList.remove("lexxy-editor--drag-over");
    }
  }

  #handleDragOver(event) {
    event.preventDefault();
  }

  #handleDrop(event) {
    event.preventDefault();

    this.dragCounter = 0;
    this.editor.getRootElement().classList.remove("lexxy-editor--drag-over");

    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) return

    const files = Array.from(dataTransfer.files);
    if (!files.length) return

    for (const file of files) {
      this.contents.uploadFile(file);
    }

    this.editor.focus();
  }

  #handleListIndentation(event) {
    if (this.selection.isInsideList) {
      event.preventDefault();
      if (event.shiftKey) {
        return this.editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined)
      } else {
        return this.editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined)
      }
    }
    return false
  }

  // Not using TOGGLE_LINK_COMMAND because it's not handled unless you use React/LinkPlugin
  #toggleLink(url) {
    this.editor.update(() => {
      if (url === null) {
        $toggleLink(null);
      } else {
        $toggleLink(url);
      }
    });
  }
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

function debounceAsync(fn, wait) {
  let timeout;

  return (...args) => {
    clearTimeout(timeout);

    return new Promise((resolve, reject) => {
      timeout = setTimeout(async () => {
        try {
          const result = await fn(...args);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      }, wait);
    })
  }
}

function nextFrame() {
  return new Promise(requestAnimationFrame)
}

class Selection {
  constructor(editorElement) {
    this.editorElement = editorElement;
    this.editorContentElement = editorElement.editorContentElement;
    this.editor = this.editorElement.editor;
    this.previouslySelectedKeys = new Set();

    this.#listenForNodeSelections();
    this.#processSelectionChangeCommands();
    this.#handleInputWhenDecoratorNodesSelected();
    this.#containEditorFocus();
  }

  clear() {
    this.current = null;
  }

  set current(selection) {
    if ($isNodeSelection(selection)) {
      this.editor.getEditorState().read(() => {
        this._current = $getSelection();
        this.#syncSelectedClasses();
      });
    } else {
      this.editor.update(() => {
        this.#syncSelectedClasses();
        this._current = null;
      });
    }
  }

  get current() {
    return this._current
  }

  get cursorPosition() {
    let position = { x: 0, y: 0 };

    this.editor.getEditorState().read(() => {
      const range = this.#getValidSelectionRange();
      if (!range) return

      const rect = this.#getReliableRectFromRange(range);
      if (!rect) return

      position = this.#calculateCursorPosition(rect, range);
    });

    return position
  }

  placeCursorAtTheEnd() {
    this.editor.update(() => {
      $getRoot().selectEnd();
    });
  }

  selectedNodeWithOffset() {
    const selection = $getSelection();
    if (!selection) return { node: null, offset: 0 }

    if ($isRangeSelection(selection)) {
      return {
        node: selection.anchor.getNode(),
        offset: selection.anchor.offset
      }
    } else if ($isNodeSelection(selection)) {
      const [ node ] = selection.getNodes();
      return {
        node,
        offset: 0
      }
    }

    return { node: null, offset: 0 }
  }

  preservingSelection(fn) {
    let selectionState = null;

    this.editor.getEditorState().read(() => {
      const selection = $getSelection();
      if (selection && $isRangeSelection(selection)) {
        selectionState = {
          anchor: { key: selection.anchor.key, offset: selection.anchor.offset },
          focus: { key: selection.focus.key, offset: selection.focus.offset }
        };
      }
    });

    fn();

    if (selectionState) {
      this.editor.update(() => {
        const selection = $getSelection();
        if (selection && $isRangeSelection(selection)) {
          selection.anchor.set(selectionState.anchor.key, selectionState.anchor.offset, "text");
          selection.focus.set(selectionState.focus.key, selectionState.focus.offset, "text");
        }
      });
    }
  }

  get hasSelectedWordsInSingleLine() {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return false

    if (selection.isCollapsed()) return false

    const anchorNode = selection.anchor.getNode();
    const focusNode = selection.focus.getNode();

    if (anchorNode.getTopLevelElement() !== focusNode.getTopLevelElement()) {
      return false
    }

    const anchorElement = anchorNode.getTopLevelElement();
    if (!anchorElement) return false

    const nodes = selection.getNodes();
    for (const node of nodes) {
      if ($isLineBreakNode(node)) {
        return false
      }
    }

    return true
  }

  get isInsideList() {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return false

    const anchorNode = selection.anchor.getNode();
    return getNearestListItemNode(anchorNode) !== null
  }

  get nodeAfterCursor() {
    const { anchorNode, offset } = this.#getCollapsedSelectionData();
    if (!anchorNode) return null

    if ($isTextNode(anchorNode)) {
      return this.#getNodeAfterTextNode(anchorNode, offset)
    }

    if ($isElementNode(anchorNode)) {
      return this.#getNodeAfterElementNode(anchorNode, offset)
    }

    return this.#findNextSiblingUp(anchorNode)
  }

  get topLevelNodeAfterCursor() {
    const { anchorNode, offset } = this.#getCollapsedSelectionData();
    if (!anchorNode) return null

    if ($isTextNode(anchorNode)) {
      return this.#getNextNodeFromTextEnd(anchorNode)
    }

    if ($isElementNode(anchorNode)) {
      return this.#getNodeAfterElementNode(anchorNode, offset)
    }

    return this.#findNextSiblingUp(anchorNode)
  }

  get nodeBeforeCursor() {
    const { anchorNode, offset } = this.#getCollapsedSelectionData();
    if (!anchorNode) return null

    if ($isTextNode(anchorNode)) {
      return this.#getNodeBeforeTextNode(anchorNode, offset)
    }

    if ($isElementNode(anchorNode)) {
      return this.#getNodeBeforeElementNode(anchorNode, offset)
    }

    return this.#findPreviousSiblingUp(anchorNode)
  }

  get topLevelNodeBeforeCursor() {
    const { anchorNode, offset } = this.#getCollapsedSelectionData();
    if (!anchorNode) return null

    if ($isTextNode(anchorNode)) {
      return this.#getPreviousNodeFromTextStart(anchorNode)
    }

    if ($isElementNode(anchorNode)) {
      return this.#getNodeBeforeElementNode(anchorNode, offset)
    }

    return this.#findPreviousSiblingUp(anchorNode)
  }

  get #contents() {
    return this.editorElement.contents
  }

  get #currentlySelectedKeys() {
    if (this._currentlySelectedKeys) { return this._currentlySelectedKeys }

    this._currentlySelectedKeys = new Set();

    const selection = $getSelection();
    if (selection && $isNodeSelection(selection)) {
      for (const node of selection.getNodes()) {
        this._currentlySelectedKeys.add(node.getKey());
      }
    }

    return this._currentlySelectedKeys
  }

  #processSelectionChangeCommands() {
    this.editor.registerCommand(KEY_ARROW_LEFT_COMMAND, this.#selectPreviousNode.bind(this), COMMAND_PRIORITY_LOW);
    this.editor.registerCommand(KEY_ARROW_RIGHT_COMMAND, this.#selectNextNode.bind(this), COMMAND_PRIORITY_LOW);
    this.editor.registerCommand(KEY_ARROW_UP_COMMAND, this.#selectPreviousTopLevelNode.bind(this), COMMAND_PRIORITY_LOW);
    this.editor.registerCommand(KEY_ARROW_DOWN_COMMAND, this.#selectNextTopLevelNode.bind(this), COMMAND_PRIORITY_LOW);

    this.editor.registerCommand(KEY_DELETE_COMMAND, this.#deleteSelectedOrNext.bind(this), COMMAND_PRIORITY_LOW);
    this.editor.registerCommand(KEY_BACKSPACE_COMMAND, this.#deletePreviousOrNext.bind(this), COMMAND_PRIORITY_LOW);

    this.editor.registerCommand(SELECTION_CHANGE_COMMAND, () => {
      this.current = $getSelection();
    }, COMMAND_PRIORITY_LOW);
  }

  #listenForNodeSelections() {
    this.editor.getRootElement().addEventListener("lexxy:internal:select-node", async (event) => {
      await nextFrame();

      const { key } = event.detail;
      this.editor.update(() => {
        const node = $getNodeByKey(key);
        if (node) {
          const selection = $createNodeSelection();
          selection.add(node.getKey());
          $setSelection(selection);
        }
        this.editor.focus();
      });
    });

    this.editor.getRootElement().addEventListener("lexxy:internal:move-to-next-line", (event) => {
      this.#selectOrAppendNextLine();
    });
  }

  // In Safari, when the only node in the document is an attachment, it won't let you enter text
  // before/below it. There is probably a better fix here, but this workaround solves the problem until
  // we find it.
  #handleInputWhenDecoratorNodesSelected() {
    this.editor.getRootElement().addEventListener("keydown", (event) => {
      if (isPrintableCharacter(event)) {
        this.editor.update(() => {
          const selection = $getSelection();

          if ($isRangeSelection(selection) && selection.isCollapsed()) {
            const anchorNode = selection.anchor.getNode();
            const offset = selection.anchor.offset;

            const nodeBefore = this.#getNodeBeforePosition(anchorNode, offset);
            const nodeAfter = this.#getNodeAfterPosition(anchorNode, offset);

            if (nodeBefore instanceof DecoratorNode && !nodeBefore.isInline()) {
              event.preventDefault();
              this.#contents.createParagraphAfterNode(nodeBefore, event.key);
              return
            } else if (nodeAfter instanceof DecoratorNode && !nodeAfter.isInline()) {
              event.preventDefault();
              this.#contents.createParagraphBeforeNode(nodeAfter, event.key);
              return
            }
          }
        });
      }
    }, true);
  }

  #getNodeBeforePosition(node, offset) {
    if ($isTextNode(node) && offset === 0) {
      return node.getPreviousSibling()
    }
    if ($isElementNode(node) && offset > 0) {
      return node.getChildAtIndex(offset - 1)
    }
    return null
  }

  #getNodeAfterPosition(node, offset) {
    if ($isTextNode(node) && offset === node.getTextContentSize()) {
      return node.getNextSibling()
    }
    if ($isElementNode(node)) {
      return node.getChildAtIndex(offset)
    }
    return null
  }

  #containEditorFocus() {
    // Workaround for a bizarre Chrome bug where the cursor abandons the editor to focus on not-focusable elements
    // above when navigating UP/DOWN when Lexical shows its fake cursor on custom decorator nodes.
    this.editorContentElement.addEventListener("keydown", (event) => {
      if (event.key === "ArrowUp") {
        const lexicalCursor = this.editor.getRootElement().querySelector("[data-lexical-cursor]");

        if (lexicalCursor) {
          let currentElement = lexicalCursor.previousElementSibling;
          while (currentElement && currentElement.hasAttribute("data-lexical-cursor")) {
            currentElement = currentElement.previousElementSibling;
          }

          if (!currentElement) {
            event.preventDefault();
          }
        }
      }

      if (event.key === "ArrowDown") {
        const lexicalCursor = this.editor.getRootElement().querySelector("[data-lexical-cursor]");

        if (lexicalCursor) {
          let currentElement = lexicalCursor.nextElementSibling;
          while (currentElement && currentElement.hasAttribute("data-lexical-cursor")) {
            currentElement = currentElement.nextElementSibling;
          }

          if (!currentElement) {
            event.preventDefault();
          }
        }
      }
    }, true);
  }

  #syncSelectedClasses() {
    this.#clearPreviouslyHighlightedItems();
    this.#highlightNewItems();

    this.previouslySelectedKeys = this.#currentlySelectedKeys;
    this._currentlySelectedKeys = null;
  }

  #clearPreviouslyHighlightedItems() {
    for (const key of this.previouslySelectedKeys) {
      if (!this.#currentlySelectedKeys.has(key)) {
        const dom = this.editor.getElementByKey(key);
        if (dom) dom.classList.remove("node--selected");
      }
    }
  }

  #highlightNewItems() {
    for (const key of this.#currentlySelectedKeys) {
      if (!this.previouslySelectedKeys.has(key)) {
        const nodeElement = this.editor.getElementByKey(key);
        if (nodeElement) nodeElement.classList.add("node--selected");
      }
    }
  }

  async #selectPreviousNode() {
    if (this.current) {
      await this.#withCurrentNode((currentNode) => currentNode.selectPrevious());
    } else {
      this.#selectInLexical(this.nodeBeforeCursor);
    }
  }

  async #selectNextNode() {
    if (this.current) {
      await this.#withCurrentNode((currentNode) => currentNode.selectNext(0, 0));
    } else {
      this.#selectInLexical(this.nodeAfterCursor);
    }
  }

  async #selectPreviousTopLevelNode() {
    if (this.current) {
      await this.#withCurrentNode((currentNode) => currentNode.selectPrevious());
    } else {
      this.#selectInLexical(this.topLevelNodeBeforeCursor);
    }
  }

  async #selectNextTopLevelNode() {
    if (this.current) {
      await this.#withCurrentNode((currentNode) => currentNode.selectNext(0, 0));
    } else {
      this.#selectInLexical(this.topLevelNodeAfterCursor);
    }
  }

  async #withCurrentNode(fn) {
    await nextFrame();
    if (this.current) {
      this.editor.update(() => {
        this.clear();
        // Use fresh selection - cached this.current may be frozen
        // See: https://github.com/facebook/lexical/issues/6290
        const selection = $getSelection();
        if ($isNodeSelection(selection)) {
          fn(selection.getNodes()[0]);
        }
        this.editor.focus();
      });
    }
  }

  async #selectOrAppendNextLine() {
    this.editor.update(() => {
      const topLevelElement = this.#getTopLevelElementFromSelection();
      if (!topLevelElement) return

      this.#moveToOrCreateNextLine(topLevelElement);
    });
  }

  #getTopLevelElementFromSelection() {
    const selection = $getSelection();
    if (!selection) return null

    if ($isNodeSelection(selection)) {
      return this.#getTopLevelFromNodeSelection(selection)
    }

    if ($isRangeSelection(selection)) {
      return this.#getTopLevelFromRangeSelection(selection)
    }

    return null
  }

  #getTopLevelFromNodeSelection(selection) {
    const nodes = selection.getNodes();
    return nodes.length > 0 ? nodes[0].getTopLevelElement() : null
  }

  #getTopLevelFromRangeSelection(selection) {
    const anchorNode = selection.anchor.getNode();
    return anchorNode.getTopLevelElement()
  }

  #moveToOrCreateNextLine(topLevelElement) {
    const nextSibling = topLevelElement.getNextSibling();

    if (nextSibling) {
      nextSibling.selectStart();
    } else {
      this.#createAndSelectNewParagraph();
    }
  }

  #createAndSelectNewParagraph() {
    const root = $getRoot();
    const newParagraph = $createParagraphNode();
    root.append(newParagraph);
    newParagraph.selectStart();
  }

  #selectInLexical(node) {
    if (!node || !(node instanceof DecoratorNode)) return

    this.editor.update(() => {
      const selection = $createNodeSelection();
      selection.add(node.getKey());
      $setSelection(selection);
    });
  }

  #deleteSelectedOrNext() {
    const node = this.nodeAfterCursor;
    if (node instanceof DecoratorNode) {
      this.#selectInLexical(node);
      return true
    } else {
      this.#contents.deleteSelectedNodes();
    }

    return false
  }

  #deletePreviousOrNext() {
    const node = this.nodeBeforeCursor;
    if (node instanceof DecoratorNode) {
      this.#selectInLexical(node);
      return true
    } else {
      this.#contents.deleteSelectedNodes();
    }

    return false
  }

  #getValidSelectionRange() {
    const lexicalSelection = $getSelection();
    if (!lexicalSelection || !lexicalSelection.isCollapsed()) return null

    const nativeSelection = window.getSelection();
    if (!nativeSelection || nativeSelection.rangeCount === 0) return null

    return nativeSelection.getRangeAt(0)
  }

  #getReliableRectFromRange(range) {
    let rect = range.getBoundingClientRect();

    if (this.#isRectUnreliable(rect)) {
      const marker = this.#createAndInsertMarker(range);
      rect = marker.getBoundingClientRect();
      this.#restoreSelectionAfterMarker(marker);
      marker.remove();
    }

    return rect
  }

  #isRectUnreliable(rect) {
    return rect.width === 0 && rect.height === 0 || rect.top === 0 && rect.left === 0
  }

  #createAndInsertMarker(range) {
    const marker = this.#createMarker();
    range.insertNode(marker);
    return marker
  }

  #createMarker() {
    const marker = document.createElement("span");
    marker.textContent = "\u200b";
    marker.style.display = "inline-block";
    marker.style.width = "1px";
    marker.style.height = "1em";
    marker.style.lineHeight = "normal";
    marker.setAttribute("nonce", getNonce());
    return marker
  }

  #restoreSelectionAfterMarker(marker) {
    const nativeSelection = window.getSelection();
    nativeSelection.removeAllRanges();
    const newRange = document.createRange();
    newRange.setStartAfter(marker);
    newRange.collapse(true);
    nativeSelection.addRange(newRange);
  }

  #calculateCursorPosition(rect, range) {
    const rootRect = this.editor.getRootElement().getBoundingClientRect();
    const x = rect.left - rootRect.left;
    let y = rect.top - rootRect.top;

    const fontSize = this.#getFontSizeForCursor(range);
    if (!isNaN(fontSize)) {
      y += fontSize;
    }

    return { x, y, fontSize }
  }

  #getFontSizeForCursor(range) {
    const nativeSelection = window.getSelection();
    const anchorNode = nativeSelection.anchorNode;
    const parentElement = this.#getElementFromNode(anchorNode);

    if (parentElement instanceof HTMLElement) {
      const computed = window.getComputedStyle(parentElement);
      return parseFloat(computed.fontSize)
    }

    return 0
  }

  #getElementFromNode(node) {
    return node?.nodeType === Node.TEXT_NODE ? node.parentElement : node
  }

  #getCollapsedSelectionData() {
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
      return { anchorNode: null, offset: 0 }
    }

    const { anchor } = selection;
    return { anchorNode: anchor.getNode(), offset: anchor.offset }
  }

  #getNodeAfterTextNode(anchorNode, offset) {
    if (offset === anchorNode.getTextContentSize()) {
      return this.#getNextNodeFromTextEnd(anchorNode)
    }
    return null
  }

  #getNextNodeFromTextEnd(anchorNode) {
    if (anchorNode.getNextSibling() instanceof DecoratorNode) {
      return anchorNode.getNextSibling()
    }
    const parent = anchorNode.getParent();
    return parent ? parent.getNextSibling() : null
  }

  #getNodeAfterElementNode(anchorNode, offset) {
    if (offset < anchorNode.getChildrenSize()) {
      return anchorNode.getChildAtIndex(offset)
    }
    return this.#findNextSiblingUp(anchorNode)
  }

  #getNodeBeforeTextNode(anchorNode, offset) {
    if (offset === 0) {
      return this.#getPreviousNodeFromTextStart(anchorNode)
    }
    return null
  }

  #getPreviousNodeFromTextStart(anchorNode) {
    if (anchorNode.getPreviousSibling() instanceof DecoratorNode) {
      return anchorNode.getPreviousSibling()
    }
    const parent = anchorNode.getParent();
    return parent.getPreviousSibling()
  }

  #getNodeBeforeElementNode(anchorNode, offset) {
    if (offset > 0) {
      return anchorNode.getChildAtIndex(offset - 1)
    }
    return this.#findPreviousSiblingUp(anchorNode)
  }

  #findNextSiblingUp(node) {
    let current = node;
    while (current && current.getNextSibling() == null) {
      current = current.getParent();
    }
    return current ? current.getNextSibling() : null
  }

  #findPreviousSiblingUp(node) {
    let current = node;
    while (current && current.getPreviousSibling() == null) {
      current = current.getParent();
    }
    return current ? current.getPreviousSibling() : null
  }
}

class CustomActionTextAttachmentNode extends DecoratorNode {
  static getType() {
    return "custom_action_text_attachment"
  }

  static clone(node) {
    return new CustomActionTextAttachmentNode({ ...node }, node.__key)
  }

  static importJSON(serializedNode) {
    return new CustomActionTextAttachmentNode({ ...serializedNode })
  }

  static importDOM() {
    return {
      "action-text-attachment": (attachment) => {
        const content = attachment.getAttribute("content");
        if (!attachment.getAttribute("content")) {
          return null
        }

        return {
          conversion: () => {
            // Preserve initial space if present since Lexical removes it
            const nodes = [];
            const previousSibling = attachment.previousSibling;
            if (previousSibling && previousSibling.nodeType === Node.TEXT_NODE && /\s$/.test(previousSibling.textContent)) {
              nodes.push($createTextNode(" "));
            }

            nodes.push(new CustomActionTextAttachmentNode({
              sgid: attachment.getAttribute("sgid"),
              innerHtml: JSON.parse(content),
              contentType: attachment.getAttribute("content-type")
            }));

            nodes.push($createTextNode(" "));

            return { node: nodes }
          },
          priority: 2
        }
      }
    }
  }

  constructor({ sgid, contentType, innerHtml }, key) {
    super(key);

    this.sgid = sgid;
    this.contentType = contentType || "application/vnd.actiontext.unknown";
    this.innerHtml = innerHtml;
  }

  createDOM() {
    const figure = createElement("action-text-attachment", { "content-type": this.contentType, "data-lexxy-decorator": true });

    figure.addEventListener("click", (event) => {
      dispatchCustomEvent(figure, "lexxy:internal:select-node", { key: this.getKey() });
    });

    figure.insertAdjacentHTML("beforeend", this.innerHtml);

    return figure
  }

  updateDOM() {
    return true
  }

  getTextContent() {
    return this.createDOM().textContent.trim() || `[${this.contentType}]`
  }

  isInline() {
    return true
  }

  exportDOM() {
    const attachment = createElement("action-text-attachment", {
      sgid: this.sgid,
      content: JSON.stringify(this.innerHtml),
      "content-type": this.contentType
    });

    return { element: attachment }
  }

  exportJSON() {
    return {
      type: "custom_action_text_attachment",
      version: 1,
      sgid: this.sgid,
      contentType: this.contentType,
      innerHtml: this.innerHtml
    }
  }

  decorate() {
    return null
  }
}

class FormatEscaper {
  constructor(editorElement) {
    this.editorElement = editorElement;
    this.editor = editorElement.editor;
  }

  monitor() {
    this.editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => this.#handleEnterKey(event),
      COMMAND_PRIORITY_HIGH
    );
  }

  #handleEnterKey(event) {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return false

    const anchorNode = selection.anchor.getNode();

    if (!this.#isInsideBlockquote(anchorNode)) return false

    return this.#handleLists(event, anchorNode)
      || this.#handleBlockquotes(event, anchorNode)
  }

  #handleLists(event, anchorNode) {
    if (this.#shouldEscapeFromEmptyListItem(anchorNode) || this.#shouldEscapeFromEmptyParagraphInListItem(anchorNode)) {
      event.preventDefault();
      this.#escapeFromList(anchorNode);
      return true
    }

    return false
  }

  #handleBlockquotes(event, anchorNode) {
    if (this.#shouldEscapeFromEmptyParagraphInBlockquote(anchorNode)) {
      event.preventDefault();
      this.#escapeFromBlockquote(anchorNode);
      return true
    }

    return false
  }

  #isInsideBlockquote(node) {
    let currentNode = node;

    while (currentNode) {
      if ($isQuoteNode(currentNode)) {
        return true
      }
      currentNode = currentNode.getParent();
    }

    return false
  }

  #shouldEscapeFromEmptyListItem(node) {
    const listItem = this.#getListItemNode(node);
    if (!listItem) return false

    return this.#isNodeEmpty(listItem)
  }

  #shouldEscapeFromEmptyParagraphInListItem(node) {
    const paragraph = this.#getParagraphNode(node);
    if (!paragraph) return false

    if (!this.#isNodeEmpty(paragraph)) return false

    const parent = paragraph.getParent();
    return parent && $isListItemNode(parent)
  }

  #isNodeEmpty(node) {
    if (node.getTextContent().trim() !== "") return false

    const children = node.getChildren();
    if (children.length === 0) return true

    return children.every(child => {
      if ($isLineBreakNode(child)) return true
      return this.#isNodeEmpty(child)
    })
  }

  #getListItemNode(node) {
    let currentNode = node;

    while (currentNode) {
      if ($isListItemNode(currentNode)) {
        return currentNode
      }
      currentNode = currentNode.getParent();
    }

    return null
  }

  #escapeFromList(anchorNode) {
    const listItem = this.#getListItemNode(anchorNode);
    if (!listItem) return

    const parentList = listItem.getParent();
    if (!parentList || !$isListNode(parentList)) return

    const blockquote = parentList.getParent();
    const isInBlockquote = blockquote && $isQuoteNode(blockquote);

    if (isInBlockquote) {
      const listItemsAfter = this.#getListItemSiblingsAfter(listItem);
      const nonEmptyListItems = listItemsAfter.filter(item => !this.#isNodeEmpty(item));

      if (nonEmptyListItems.length > 0) {
        this.#splitBlockquoteWithList(blockquote, parentList, listItem, nonEmptyListItems);
        return
      }
    }

    const paragraph = $createParagraphNode();
    parentList.insertAfter(paragraph);

    listItem.remove();
    paragraph.selectStart();
  }

  #shouldEscapeFromEmptyParagraphInBlockquote(node) {
    const paragraph = this.#getParagraphNode(node);
    if (!paragraph) return false

    if (!this.#isNodeEmpty(paragraph)) return false

    const parent = paragraph.getParent();
    return parent && $isQuoteNode(parent)
  }

  #getParagraphNode(node) {
    let currentNode = node;

    while (currentNode) {
      if ($isParagraphNode(currentNode)) {
        return currentNode
      }
      currentNode = currentNode.getParent();
    }

    return null
  }

  #escapeFromBlockquote(anchorNode) {
    const paragraph = this.#getParagraphNode(anchorNode);
    if (!paragraph) return

    const blockquote = paragraph.getParent();
    if (!blockquote || !$isQuoteNode(blockquote)) return

    const siblingsAfter = this.#getSiblingsAfter(paragraph);
    const nonEmptySiblings = siblingsAfter.filter(sibling => !this.#isNodeEmpty(sibling));

    if (nonEmptySiblings.length > 0) {
      this.#splitBlockquote(blockquote, paragraph, nonEmptySiblings);
    } else {
      const newParagraph = $createParagraphNode();
      blockquote.insertAfter(newParagraph);
      paragraph.remove();
      newParagraph.selectStart();
    }
  }

  #getSiblingsAfter(node) {
    const siblings = [];
    let sibling = node.getNextSibling();

    while (sibling) {
      siblings.push(sibling);
      sibling = sibling.getNextSibling();
    }

    return siblings
  }

  #getListItemSiblingsAfter(listItem) {
    const siblings = [];
    let sibling = listItem.getNextSibling();

    while (sibling) {
      if ($isListItemNode(sibling)) {
        siblings.push(sibling);
      }
      sibling = sibling.getNextSibling();
    }

    return siblings
  }

  #splitBlockquoteWithList(blockquote, parentList, emptyListItem, listItemsAfter) {
    const blockquoteSiblingsAfterList = this.#getSiblingsAfter(parentList);
    const nonEmptyBlockquoteSiblings = blockquoteSiblingsAfterList.filter(sibling => !this.#isNodeEmpty(sibling));

    const middleParagraph = $createParagraphNode();
    blockquote.insertAfter(middleParagraph);

    const newList = $createListNode(parentList.getListType());

    const newBlockquote = $createQuoteNode();
    middleParagraph.insertAfter(newBlockquote);
    newBlockquote.append(newList);

    listItemsAfter.forEach(item => {
      newList.append(item);
    });

    nonEmptyBlockquoteSiblings.forEach(sibling => {
      newBlockquote.append(sibling);
    });

    emptyListItem.remove();

    this.#removeTrailingEmptyListItems(parentList);
    this.#removeTrailingEmptyNodes(newBlockquote);

    if (parentList.getChildrenSize() === 0) {
      parentList.remove();

      if (blockquote.getChildrenSize() === 0) {
        blockquote.remove();
      }
    } else {
      this.#removeTrailingEmptyNodes(blockquote);
    }

    middleParagraph.selectStart();
  }

  #removeTrailingEmptyListItems(list) {
    const items = list.getChildren();
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if ($isListItemNode(item) && this.#isNodeEmpty(item)) {
        item.remove();
      } else {
        break
      }
    }
  }

  #removeTrailingEmptyNodes(blockquote) {
    const children = blockquote.getChildren();
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (this.#isNodeEmpty(child)) {
        child.remove();
      } else {
        break
      }
    }
  }

  #splitBlockquote(blockquote, emptyParagraph, siblingsAfter) {
    const newParagraph = $createParagraphNode();
    blockquote.insertAfter(newParagraph);

    const newBlockquote = $createQuoteNode();
    newParagraph.insertAfter(newBlockquote);

    siblingsAfter.forEach(sibling => {
      newBlockquote.append(sibling);
    });

    emptyParagraph.remove();

    this.#removeTrailingEmptyNodes(blockquote);
    this.#removeTrailingEmptyNodes(newBlockquote);

    newParagraph.selectStart();
  }
}

class Contents {
  constructor(editorElement) {
    this.editorElement = editorElement;
    this.editor = editorElement.editor;

    new FormatEscaper(editorElement).monitor();
  }

  insertHtml(html) {
    this.editor.update(() => {
      const selection = $getSelection();

      if (!$isRangeSelection(selection)) return

      const nodes = $generateNodesFromDOM(this.editor, parseHtml(html));
      selection.insertNodes(nodes);
    });
  }

  insertAtCursor(node) {
    this.editor.update(() => {
      const selection = $getSelection();
      const selectedNodes = selection?.getNodes();

      if ($isRangeSelection(selection)) {
        $insertNodes([ node ]);
      } else if ($isNodeSelection(selection) && selectedNodes && selectedNodes.length > 0) {
        const lastNode = selectedNodes[selectedNodes.length - 1];
        lastNode.insertAfter(node);
      } else {
        const root = $getRoot();
        root.append(node);
      }
    });
  }

  insertAtCursorEnsuringLineBelow(node) {
    this.insertAtCursor(node);
    this.#insertLineBelowIfLastNode(node);
  }

  insertNodeWrappingEachSelectedLine(newNodeFn) {
    this.editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return

      const selectedNodes = selection.extract();

      selectedNodes.forEach((node) => {
        const parent = node.getParent();
        if (!parent) { return }

        const topLevelElement = node.getTopLevelElementOrThrow();
        const wrappingNode = newNodeFn();
        wrappingNode.append(...topLevelElement.getChildren());
        topLevelElement.replace(wrappingNode);
      });
    });
  }

  toggleNodeWrappingAllSelectedLines(isFormatAppliedFn, newNodeFn) {
    this.editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return

      const topLevelElement = selection.anchor.getNode().getTopLevelElementOrThrow();

      // Check if format is already applied
      if (isFormatAppliedFn(topLevelElement)) {
        this.removeFormattingFromSelectedLines();
      } else {
        this.#insertNodeWrappingAllSelectedLines(newNodeFn);
      }
    });
  }

  toggleNodeWrappingAllSelectedNodes(isFormatAppliedFn, newNodeFn) {
    this.editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return

      const topLevelElement = selection.anchor.getNode().getTopLevelElement();

      // Check if format is already applied
      if (topLevelElement && isFormatAppliedFn(topLevelElement)) {
        this.#unwrap(topLevelElement);
      } else {
        this.#insertNodeWrappingAllSelectedNodes(newNodeFn);
      }
    });
  }

  removeFormattingFromSelectedLines() {
    this.editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return

      const topLevelElement = selection.anchor.getNode().getTopLevelElementOrThrow();
      const paragraph = $createParagraphNode();
      paragraph.append(...topLevelElement.getChildren());
      topLevelElement.replace(paragraph);
    });
  }

  hasSelectedText() {
    let result = false;

    this.editor.read(() => {
      const selection = $getSelection();
      result = $isRangeSelection(selection) && !selection.isCollapsed();
    });

    return result
  }

  unwrapSelectedListItems() {
    this.editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return

      const { listItems, parentLists } = this.#collectSelectedListItems(selection);
      if (listItems.size > 0) {
        const newParagraphs = this.#convertListItemsToParagraphs(listItems);
        this.#removeEmptyParentLists(parentLists);
        this.#selectNewParagraphs(newParagraphs);
      }
    });
  }

  createLink(url) {
    let linkNodeKey = null;

    this.editor.update(() => {
      const textNode = $createTextNode(url);
      const linkNode = $createLinkNode(url);
      linkNode.append(textNode);

      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        selection.insertNodes([ linkNode ]);
        linkNodeKey = linkNode.getKey();
      }
    });

    return linkNodeKey
  }

  createLinkWithSelectedText(url) {
    if (!this.hasSelectedText()) return

    this.editor.update(() => {
      $toggleLink(url);
    });
  }

  textBackUntil(string) {
    let result = "";

    this.editor.getEditorState().read(() => {
      const selection = $getSelection();
      if (!selection || !selection.isCollapsed()) return

      const anchor = selection.anchor;
      const anchorNode = anchor.getNode();

      if (!$isTextNode(anchorNode)) return

      const fullText = anchorNode.getTextContent();
      const offset = anchor.offset;

      const textBeforeCursor = fullText.slice(0, offset);

      const lastIndex = textBeforeCursor.lastIndexOf(string);
      if (lastIndex !== -1) {
        result = textBeforeCursor.slice(lastIndex + string.length);
      }
    });

    return result
  }

  containsTextBackUntil(string) {
    let result = false;

    this.editor.getEditorState().read(() => {
      const selection = $getSelection();
      if (!selection || !selection.isCollapsed()) return

      const anchor = selection.anchor;
      const anchorNode = anchor.getNode();

      if (!$isTextNode(anchorNode)) return

      const fullText = anchorNode.getTextContent();
      const offset = anchor.offset;

      const textBeforeCursor = fullText.slice(0, offset);

      result = textBeforeCursor.includes(string);
    });

    return result
  }

  replaceTextBackUntil(stringToReplace, replacementNodes) {
    replacementNodes = Array.isArray(replacementNodes) ? replacementNodes : [ replacementNodes ];

    this.editor.update(() => {
      const { anchorNode, offset } = this.#getTextAnchorData();
      if (!anchorNode) return

      const lastIndex = this.#findLastIndexBeforeCursor(anchorNode, offset, stringToReplace);
      if (lastIndex === -1) return

      this.#performTextReplacement(anchorNode, offset, lastIndex, replacementNodes);
    });
  }

  createParagraphAfterNode(node, text) {
    const newParagraph = $createParagraphNode();
    node.insertAfter(newParagraph);
    newParagraph.selectStart();

    // Insert the typed text
    if (text) {
      newParagraph.append($createTextNode(text));
      newParagraph.select(1, 1); // Place cursor after the text
    }
  }

  createParagraphBeforeNode(node, text) {
    const newParagraph = $createParagraphNode();
    node.insertBefore(newParagraph);
    newParagraph.selectStart();

    // Insert the typed text
    if (text) {
      newParagraph.append($createTextNode(text));
      newParagraph.select(1, 1); // Place cursor after the text
    }
  }

  uploadFile(file) {
    if (!this.editorElement.supportsAttachments) {
      console.warn("This editor does not supports attachments (it's configured with [attachments=false])");
      return
    }

    if (!this.#shouldUploadFile(file)) {
      return
    }

    const uploadUrl = this.editorElement.directUploadUrl;
    const blobUrlTemplate = this.editorElement.blobUrlTemplate;

    this.editor.update(() => {
      const uploadedImageNode = new ActionTextAttachmentUploadNode({ file: file, uploadUrl: uploadUrl, blobUrlTemplate: blobUrlTemplate, editor: this.editor });
      this.insertAtCursor(uploadedImageNode);
    }, { tag: HISTORY_MERGE_TAG });
  }

  async deleteSelectedNodes() {
    let focusNode = null;

    this.editor.update(() => {
      // Use fresh selection - cached this.#selection.current may be frozen
      // See: https://github.com/facebook/lexical/issues/6290
      const selection = $getSelection();
      if ($isNodeSelection(selection)) {
        const nodesToRemove = selection.getNodes();
        if (nodesToRemove.length === 0) return

        focusNode = this.#findAdjacentNodeTo(nodesToRemove);
        this.#deleteNodes(nodesToRemove);
      }
    });

    await nextFrame();

    this.editor.update(() => {
      this.#selectAfterDeletion(focusNode);
      this.#selection.clear();
      this.editor.focus();
    });
  }

  replaceNodeWithHTML(nodeKey, html, options = {}) {
    this.editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (!node) return

      const selection = $getSelection();
      let wasSelected = false;

      if ($isRangeSelection(selection)) {
        const selectedNodes = selection.getNodes();
        wasSelected = selectedNodes.includes(node) || selectedNodes.some(n => n.getParent() === node);

        if (wasSelected) {
          $setSelection(null);
        }
      }

      const replacementNode = options.attachment ? this.#createCustomAttachmentNodeWithHtml(html, options.attachment) : this.#createHtmlNodeWith(html);
      node.replace(replacementNode);

      if (wasSelected) {
        replacementNode.selectEnd();
      }
    });
  }

  insertHTMLBelowNode(nodeKey, html, options = {}) {
    this.editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (!node) return

      const previousNode = node.getTopLevelElement() || node;

      const newNode = options.attachment ? this.#createCustomAttachmentNodeWithHtml(html, options.attachment) : this.#createHtmlNodeWith(html);
      previousNode.insertAfter(newNode);
    });
  }

  get #selection() {
    return this.editorElement.selection
  }

  #insertLineBelowIfLastNode(node) {
    this.editor.update(() => {
      const nextSibling = node.getNextSibling();
      if (!nextSibling) {
        const newParagraph = $createParagraphNode();
        node.insertAfter(newParagraph);
        newParagraph.selectStart();
      }
    });
  }

  #unwrap(node) {
    const children = node.getChildren();

    children.forEach((child) => {
      node.insertBefore(child);
    });

    node.remove();
  }

  #insertNodeWrappingAllSelectedNodes(newNodeFn) {
    this.editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return

      const selectedNodes = selection.extract();
      if (selectedNodes.length === 0) {
        return
      }
      const topLevelElements = new Set();
      selectedNodes.forEach((node) => {
        const topLevel = node.getTopLevelElementOrThrow();
        topLevelElements.add(topLevel);
      });

      const elements = this.#withoutTrailingEmptyParagraphs(Array.from(topLevelElements));
      if (elements.length === 0) {
        this.#removeStandaloneEmptyParagraph();
        this.insertAtCursor(newNodeFn());
        return
      }

      const wrappingNode = newNodeFn();
      elements[0].insertBefore(wrappingNode);
      elements.forEach((element) => {
        wrappingNode.append(element);
      });
    });
  }

  #withoutTrailingEmptyParagraphs(elements) {
    let lastNonEmptyIndex = elements.length - 1;

    // Find the last non-empty paragraph
    while (lastNonEmptyIndex >= 0) {
      const element = elements[lastNonEmptyIndex];
      if (!$isParagraphNode(element) || !this.#isElementEmpty(element)) {
        break
      }
      lastNonEmptyIndex--;
    }

    return elements.slice(0, lastNonEmptyIndex + 1)
  }

  #isElementEmpty(element) {
    // Check text content first
    if (element.getTextContent().trim() !== "") return false

    // Check if it only contains line breaks
    const children = element.getChildren();
    return children.length === 0 || children.every(child => $isLineBreakNode(child))
  }

  #removeStandaloneEmptyParagraph() {
    const root = $getRoot();
    if (root.getChildrenSize() === 1) {
      const firstChild = root.getFirstChild();
      if (firstChild && $isParagraphNode(firstChild) && this.#isElementEmpty(firstChild)) {
        firstChild.remove();
      }
    }
  }

  #insertNodeWrappingAllSelectedLines(newNodeFn) {
    this.editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return

      if (selection.isCollapsed()) {
        this.#wrapCurrentLine(selection, newNodeFn);
      } else {
        this.#wrapMultipleSelectedLines(selection, newNodeFn);
      }
    });
  }

  #wrapCurrentLine(selection, newNodeFn) {
    const anchorNode = selection.anchor.getNode();
    const topLevelElement = anchorNode.getTopLevelElementOrThrow();

    if (topLevelElement.getTextContent()) {
      const wrappingNode = newNodeFn();
      wrappingNode.append(...topLevelElement.getChildren());
      topLevelElement.replace(wrappingNode);
    } else {
      $insertNodes([ newNodeFn() ]);
    }
  }

  #wrapMultipleSelectedLines(selection, newNodeFn) {
    const selectedParagraphs = this.#extractSelectedParagraphs(selection);
    if (selectedParagraphs.length === 0) return

    const { lineSet, nodesToDelete } = this.#extractUniqueLines(selectedParagraphs);
    if (lineSet.size === 0) return

    const wrappingNode = this.#createWrappingNodeWithLines(newNodeFn, lineSet);
    this.#replaceWithWrappingNode(selection, wrappingNode);
    this.#removeNodes(nodesToDelete);
  }

  #extractSelectedParagraphs(selection) {
    const selectedNodes = selection.extract();
    const selectedParagraphs = selectedNodes
      .map((node) => this.#getParagraphFromNode(node))
      .filter(Boolean);

    $setSelection(null);
    return selectedParagraphs
  }

  #getParagraphFromNode(node) {
    if ($isParagraphNode(node)) return node
    if ($isTextNode(node) && node.getParent() && $isParagraphNode(node.getParent())) {
      return node.getParent()
    }
    return null
  }

  #extractUniqueLines(selectedParagraphs) {
    const lineSet = new Set();
    const nodesToDelete = new Set();

    selectedParagraphs.forEach((paragraphNode) => {
      const textContent = paragraphNode.getTextContent();
      if (textContent) {
        textContent.split("\n").forEach((line) => {
          if (line.trim()) lineSet.add(line);
        });
      }
      nodesToDelete.add(paragraphNode);
    });

    return { lineSet, nodesToDelete }
  }

  #createWrappingNodeWithLines(newNodeFn, lineSet) {
    const wrappingNode = newNodeFn();
    const lines = Array.from(lineSet);

    lines.forEach((lineText, index) => {
      wrappingNode.append($createTextNode(lineText));
      if (index < lines.length - 1) {
        wrappingNode.append($createLineBreakNode());
      }
    });

    return wrappingNode
  }

  #replaceWithWrappingNode(selection, wrappingNode) {
    const anchorNode = selection.anchor.getNode();
    const parent = anchorNode.getParent();
    if (parent) {
      parent.replace(wrappingNode);
    }
  }

  #removeNodes(nodesToDelete) {
    nodesToDelete.forEach((node) => node.remove());
  }

  #deleteNodes(nodes) {
    // Use splice() instead of node.remove() for proper removal and
    // reconciliation. Would have issues with removing unintended decorator nodes
    // with node.remove()
    nodes.forEach((node) => {
      const parent = node.getParent();
      if (!$isElementNode(parent)) return

      const children = parent.getChildren();
      const index = children.indexOf(node);

      if (index >= 0) {
        parent.splice(index, 1, []);
      }
    });
  }

  #findAdjacentNodeTo(nodes) {
    const firstNode = nodes[0];
    const lastNode = nodes[nodes.length - 1];

    return firstNode?.getPreviousSibling() || lastNode?.getNextSibling()
  }

  #selectAfterDeletion(focusNode) {
    const root = $getRoot();
    if (root.getChildrenSize() === 0) {
      const newParagraph = $createParagraphNode();
      root.append(newParagraph);
      newParagraph.selectStart();
    } else if (focusNode) {
      if ($isTextNode(focusNode) || $isParagraphNode(focusNode)) {
        focusNode.selectEnd();
      } else {
        focusNode.selectNext(0, 0);
      }
    }
  }

  #collectSelectedListItems(selection) {
    const nodes = selection.getNodes();
    const listItems = new Set();
    const parentLists = new Set();

    for (const node of nodes) {
      const listItem = getNearestListItemNode(node);
      if (listItem) {
        listItems.add(listItem);
        const parentList = listItem.getParent();
        if (parentList && $isListNode(parentList)) {
          parentLists.add(parentList);
        }
      }
    }

    return { listItems, parentLists }
  }

  #convertListItemsToParagraphs(listItems) {
    const newParagraphs = [];

    for (const listItem of listItems) {
      const paragraph = this.#convertListItemToParagraph(listItem);
      if (paragraph) {
        newParagraphs.push(paragraph);
      }
    }

    return newParagraphs
  }

  #convertListItemToParagraph(listItem) {
    const parentList = listItem.getParent();
    if (!parentList || !$isListNode(parentList)) return null

    const paragraph = $createParagraphNode();
    const sublists = this.#extractSublistsAndContent(listItem, paragraph);

    listItem.insertAfter(paragraph);
    this.#insertSublists(paragraph, sublists);
    listItem.remove();

    return paragraph
  }

  #extractSublistsAndContent(listItem, paragraph) {
    const sublists = [];

    listItem.getChildren().forEach((child) => {
      if ($isListNode(child)) {
        sublists.push(child);
      } else {
        paragraph.append(child);
      }
    });

    return sublists
  }

  #insertSublists(paragraph, sublists) {
    sublists.forEach((sublist) => {
      paragraph.insertAfter(sublist);
    });
  }

  #removeEmptyParentLists(parentLists) {
    for (const parentList of parentLists) {
      if ($isListNode(parentList) && parentList.getChildrenSize() === 0) {
        parentList.remove();
      }
    }
  }

  #selectNewParagraphs(newParagraphs) {
    if (newParagraphs.length === 0) return

    const firstParagraph = newParagraphs[0];
    const lastParagraph = newParagraphs[newParagraphs.length - 1];

    if (newParagraphs.length === 1) {
      firstParagraph.selectEnd();
    } else {
      this.#selectParagraphRange(firstParagraph, lastParagraph);
    }
  }

  #selectParagraphRange(firstParagraph, lastParagraph) {
    firstParagraph.selectStart();
    const currentSelection = $getSelection();
    if (currentSelection && $isRangeSelection(currentSelection)) {
      currentSelection.anchor.set(firstParagraph.getKey(), 0, "element");
      currentSelection.focus.set(lastParagraph.getKey(), lastParagraph.getChildrenSize(), "element");
    }
  }

  #getTextAnchorData() {
    const selection = $getSelection();
    if (!selection || !selection.isCollapsed()) return { anchorNode: null, offset: 0 }

    const anchor = selection.anchor;
    const anchorNode = anchor.getNode();

    if (!$isTextNode(anchorNode)) return { anchorNode: null, offset: 0 }

    return { anchorNode, offset: anchor.offset }
  }

  #findLastIndexBeforeCursor(anchorNode, offset, stringToReplace) {
    const fullText = anchorNode.getTextContent();
    const textBeforeCursor = fullText.slice(0, offset);
    return textBeforeCursor.lastIndexOf(stringToReplace)
  }

  #performTextReplacement(anchorNode, offset, lastIndex, replacementNodes) {
    const fullText = anchorNode.getTextContent();
    const textBeforeString = fullText.slice(0, lastIndex);
    const textAfterCursor = fullText.slice(offset);

    const textNodeBefore = $createTextNode(textBeforeString);
    const textNodeAfter = $createTextNode(textAfterCursor || " ");

    anchorNode.replace(textNodeBefore);

    const lastInsertedNode = this.#insertReplacementNodes(textNodeBefore, replacementNodes);
    lastInsertedNode.insertAfter(textNodeAfter);

    this.#appendLineBreakIfNeeded(textNodeAfter.getParentOrThrow());
    const cursorOffset = textAfterCursor ? 0 : 1;
    textNodeAfter.select(cursorOffset, cursorOffset);
  }

  #insertReplacementNodes(startNode, replacementNodes) {
    let previousNode = startNode;
    for (const node of replacementNodes) {
      previousNode.insertAfter(node);
      previousNode = node;
    }
    return previousNode
  }

  #appendLineBreakIfNeeded(paragraph) {
    if ($isParagraphNode(paragraph) && !this.editorElement.isSingleLineMode) {
      const children = paragraph.getChildren();
      const last = children[children.length - 1];
      const beforeLast = children[children.length - 2];

      if ($isTextNode(last) && last.getTextContent() === "" && (beforeLast && !$isTextNode(beforeLast))) {
        paragraph.append($createLineBreakNode());
      }
    }
  }

  #createCustomAttachmentNodeWithHtml(html, options = {}) {
    const attachmentConfig = typeof options === "object" ? options : {};

    return new CustomActionTextAttachmentNode({
      sgid: attachmentConfig.sgid || null,
      contentType: "text/html",
      innerHtml: html
    })
  }

  #createHtmlNodeWith(html) {
    const htmlNodes = $generateNodesFromDOM(this.editor, parseHtml(html));
    return htmlNodes[0] || $createParagraphNode()
  }

  #shouldUploadFile(file) {
    return dispatch(this.editorElement, "lexxy:file-accept", { file }, true)
  }
}

function isUrl(string) {
  try {
    new URL(string);
    return true
  } catch {
    return false
  }
}

function normalizeFilteredText(string) {
  return string
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Remove diacritics
}

function filterMatches(text, potentialMatch) {
  return normalizeFilteredText(text).includes(normalizeFilteredText(potentialMatch))
}

class Clipboard {
  constructor(editorElement) {
    this.editorElement = editorElement;
    this.editor = editorElement.editor;
    this.contents = editorElement.contents;
  }

  paste(event) {
    const clipboardData = event.clipboardData;

    if (!clipboardData) return false

    if (this.#isPlainTextOrURLPasted(clipboardData) && !this.#isPastingIntoCodeBlock()) {
      this.#pastePlainText(clipboardData);
      event.preventDefault();
      return true
    }

    this.#handlePastedFiles(clipboardData);
  }

  #isPlainTextOrURLPasted(clipboardData) {
    return this.#isOnlyPlainTextPasted(clipboardData) || this.#isOnlyURLPasted(clipboardData)
  }

  #isOnlyPlainTextPasted(clipboardData) {
    const types = Array.from(clipboardData.types);
    return types.length === 1 && types[0] === "text/plain"
  }

  #isOnlyURLPasted(clipboardData) {
    // Safari URLs are copied as a text/plain + text/uri-list object
    const types = Array.from(clipboardData.types);
    return types.length === 2 && types.includes("text/uri-list") && types.includes("text/plain")
  }

  #isPastingIntoCodeBlock() {
    let result = false;

    this.editor.getEditorState().read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return

      let currentNode = selection.anchor.getNode();

      while (currentNode) {
        if ($isCodeNode(currentNode)) {
          result = true;
          return
        }
        currentNode = currentNode.getParent();
      }
    });

    return result
  }

  #pastePlainText(clipboardData) {
    const item = clipboardData.items[0];
    item.getAsString((text) => {
      if (isUrl(text) && this.contents.hasSelectedText()) {
        this.contents.createLinkWithSelectedText(text);
      } else if (isUrl(text)) {
        const nodeKey = this.contents.createLink(text);
        this.#dispatchLinkInsertEvent(nodeKey, { url: text });
      } else {
        this.#pasteMarkdown(text);
      }
    });
  }

  #dispatchLinkInsertEvent(nodeKey, payload) {
    const linkManipulationMethods = {
      replaceLinkWith: (html, options) => this.contents.replaceNodeWithHTML(nodeKey, html, options),
      insertBelowLink: (html, options) => this.contents.insertHTMLBelowNode(nodeKey, html, options)
    };

    dispatch(this.editorElement, "lexxy:insert-link", {
      ...payload,
      ...linkManipulationMethods
    });
  }

  #pasteMarkdown(text) {
    const html = marked(text);
    this.contents.insertHtml(html);
  }

  #handlePastedFiles(clipboardData) {
    if (!this.editorElement.supportsAttachments) return

    const html = clipboardData.getData("text/html");
    if (html) return // Ignore if image copied from browser since we will load it as a remote image

    this.#preservingScrollPosition(() => {
      for (const item of clipboardData.items) {
        const file = item.getAsFile();
        if (!file) continue

        this.contents.uploadFile(file);
      }
    });
  }

  // Deals with an issue in Safari where it scrolls to the tops after pasting attachments
  async #preservingScrollPosition(callback) {
    const scrollY = window.scrollY;
    const scrollX = window.scrollX;

    callback();

    await nextFrame();

    window.scrollTo(scrollX, scrollY);
    this.editor.focus();
  }
}

class Highlighter {
  constructor(editorElement) {
    this.editor = editorElement.editor;

    this.#registerHighlightTransform();
  }

  toggle(styles) {
    this.editor.update(() => {
      this.#toggleSelectionStyles(styles);
    });
  }

  remove() {
    this.toggle({ "color": null, "background-color": null });
  }

  #registerHighlightTransform() {
    return this.editor.registerNodeTransform(TextNode, (textNode) => {
      this.#syncHighlightWithStyle(textNode);
    })
  }

  #toggleSelectionStyles(styles) {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return

    const patch = {};
    for (const property in styles) {
      const oldValue = $getSelectionStyleValueForProperty(selection, property);
      patch[property] = this.#toggleOrReplace(oldValue, styles[property]);
    }

    $patchStyleText(selection, patch);
  }

  #toggleOrReplace(oldValue, newValue) {
    return oldValue === newValue ? null : newValue
  }

  #syncHighlightWithStyle(node) {
    if (hasHighlightStyles(node.getStyle()) !== node.hasFormat("highlight")) {
      node.toggleFormat("highlight");
    }
  }
}

class HighlightNode extends TextNode {
  $config() {
    return this.config("highlight", { extends: TextNode })
  }

  static importDOM() {
    return {
      mark: () => ({
        conversion: extendTextNodeConversion("mark", applyHighlightStyle),
        priority: 1
      })
    }
  }
}

function applyHighlightStyle(textNode, element) {
  const textColor = element.style?.color;
  const backgroundColor = element.style?.backgroundColor;

  let highlightStyle = "";
  if (textColor && textColor !== "") highlightStyle += `color: ${textColor};`;
  if (backgroundColor && backgroundColor !== "") highlightStyle += `background-color: ${backgroundColor};`;

  if (highlightStyle.length) {
    if (!textNode.hasFormat("highlight")) textNode.toggleFormat("highlight");
    return textNode.setStyle(textNode.getStyle() + highlightStyle)
  }
}

const TRIX_LANGUAGE_ATTR = "language";

class TrixTextNode extends TextNode {
  $config() {
    return this.config("trix-text", { extends: TextNode })
  }

  static importDOM() {
    return {
      // em, span, and strong elements are directly styled in trix
      em: (element) => onlyStyledElements(element, {
        conversion: extendTextNodeConversion("i", applyHighlightStyle),
        priority: 1
      }),
      span: (element) => onlyStyledElements(element, {
        conversion: extendTextNodeConversion("mark", applyHighlightStyle),
        priority: 1
      }),
      strong: (element) => onlyStyledElements(element, {
        conversion: extendTextNodeConversion("b", applyHighlightStyle),
        priority: 1
      }),
      // del => s
      del: () => ({
        conversion: extendTextNodeConversion("s", applyStrikethrough),
        priority: 1
      }),
      // read "language" attribute and normalize
      pre: (element) => onlyPreLanguageElements(element, {
        conversion: extendConversion(CodeNode, "pre", applyLanguage),
        priority: 1
      })
    }
  }
}

function onlyStyledElements(element, conversion) {
  const elementHighlighted = element.style.color !== "" || element.style.backgroundColor !== "";
  return elementHighlighted ? conversion : null
}

function applyStrikethrough(textNode, element) {
  if (!textNode.hasFormat("strikethrough")) textNode.toggleFormat("strikethrough");
  return applyHighlightStyle(textNode, element)
}

function onlyPreLanguageElements(element, conversion) {
  return element.hasAttribute(TRIX_LANGUAGE_ATTR) ? conversion : null
}

function applyLanguage(conversionOutput, element) {
  const language = normalizeCodeLang(element.getAttribute(TRIX_LANGUAGE_ATTR));
  conversionOutput.node.setLanguage(language);
}

class LexicalEditorElement extends HTMLElement {
  static formAssociated = true
  static debug = false
  static commands = [ "bold", "italic", "strikethrough" ]

  static observedAttributes = [ "connected", "required" ]

  #initialValue = ""
  #validationTextArea = document.createElement("textarea")

  constructor() {
    super();
    this.internals = this.attachInternals();
    this.internals.role = "presentation";
  }

  connectedCallback() {
    this.id ??= generateDomId("lexxy-editor");
    this.editor = this.#createEditor();
    this.contents = new Contents(this);
    this.selection = new Selection(this);
    this.clipboard = new Clipboard(this);
    this.highlighter = new Highlighter(this);

    CommandDispatcher.configureFor(this);
    this.#initialize();

    requestAnimationFrame(() => dispatch(this, "lexxy:initialize"));
    this.toggleAttribute("connected", true);

    this.valueBeforeDisconnect = null;
  }

  disconnectedCallback() {
    this.valueBeforeDisconnect = this.value;
    this.#reset(); // Prevent hangs with Safari when morphing
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name === "connected" && this.isConnected && oldValue != null && oldValue !== newValue) {
      requestAnimationFrame(() => this.#reconnect());
    }

    if (name === "required" && this.isConnected) {
      this.#validationTextArea.required = this.hasAttribute("required");
      this.#setValidity();
    }
  }

  formResetCallback() {
    this.value = this.#initialValue;
    this.editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
  }

  get form() {
    return this.internals.form
  }

  get name() {
    return this.getAttribute("name")
  }

  get toolbarElement() {
    if (!this.#hasToolbar) return null

    this.toolbar = this.toolbar || this.#findOrCreateDefaultToolbar();
    return this.toolbar
  }

  get directUploadUrl() {
    return this.dataset.directUploadUrl
  }

  get blobUrlTemplate() {
    return this.dataset.blobUrlTemplate
  }

  get isEmpty() {
    return [ "<p><br></p>", "<p></p>", "" ].includes(this.value.trim())
  }

  get isBlank() {
    return this.isEmpty || this.toString().match(/^\s*$/g) !== null
  }

  get hasOpenPrompt() {
    return this.querySelector(".lexxy-prompt-menu.lexxy-prompt-menu--visible") !== null
  }

  get isSingleLineMode() {
    return this.hasAttribute("single-line")
  }

  get supportsAttachments() {
    return this.getAttribute("attachments") !== "false"
  }

  get contentTabIndex() {
    return parseInt(this.editorContentElement?.getAttribute("tabindex") ?? "0")
  }

  focus() {
    this.editor.focus();
  }

  get value() {
    if (!this.cachedValue) {
      this.editor?.getEditorState().read(() => {
        this.cachedValue = sanitize($generateHtmlFromNodes(this.editor, null));
      });
    }

    return this.cachedValue
  }

  set value(html) {
    this.editor.update(() => {
      $addUpdateTag(SKIP_DOM_SELECTION_TAG);
      const root = $getRoot();
      root.clear();
      if (html !== "") root.append(...this.#parseHtmlIntoLexicalNodes(html));
      root.select();

      this.#toggleEmptyStatus();

      // The first time you set the value, when the editor is empty, it seems to leave Lexical
      // in an inconsistent state until, at least, you focus. You can type but adding attachments
      // fails because no root node detected. This is a workaround to deal with the issue.
      requestAnimationFrame(() => this.editor?.update(() => { }));
    });
  }

  toString() {
    if (!this.cachedStringValue) {
      this.editor?.getEditorState().read(() => {
        this.cachedStringValue = $getRoot().getTextContent();
      });
    }

    return this.cachedStringValue
  }

  #parseHtmlIntoLexicalNodes(html) {
    if (!html) html = "<p></p>";
    const nodes = $generateNodesFromDOM(this.editor, parseHtml(`<div>${html}</div>`));
    // Custom decorator block elements such action-text-attachments get wrapped into <p> automatically by Lexical.
    // We flatten those.
    return nodes.map(node => {
      if (node.getType() === "paragraph" && node.getChildrenSize() === 1) {
        const child = node.getFirstChild();
        if (child instanceof DecoratorNode && !child.isInline()) {
          return child
        }
      }
      return node
    })
  }

  #initialize() {
    this.#synchronizeWithChanges();
    this.#registerComponents();
    this.#listenForInvalidatedNodes();
    this.#handleEnter();
    this.#handleFocus();
    this.#handleTables();
    this.#attachDebugHooks();
    this.#attachToolbar();
    this.#loadInitialValue();
    this.#resetBeforeTurboCaches();
  }

  #createEditor() {
    this.editorContentElement = this.editorContentElement || this.#createEditorContentElement();

    const editor = createEditor({
      namespace: "LexicalEditor",
      onError(error) {
        throw error
      },
      theme: theme,
      nodes: this.#lexicalNodes
    });

    editor.setRootElement(this.editorContentElement);

    return editor
  }

  get #lexicalNodes() {
    const nodes = [
      TrixTextNode,
      HighlightNode,
      QuoteNode,
      HeadingNode,
      ListNode,
      ListItemNode,
      CodeNode,
      CodeHighlightNode,
      LinkNode,
      AutoLinkNode,
      HorizontalDividerNode,
      TableNode,
      TableCellNode,
      TableRowNode,

      CustomActionTextAttachmentNode,
    ];

    if (this.supportsAttachments) {
      nodes.push(ActionTextAttachmentNode, ActionTextAttachmentUploadNode);
    }

    return nodes
  }

  #createEditorContentElement() {
    const editorContentElement = createElement("div", {
      classList: "lexxy-editor__content",
      contenteditable: true,
      role: "textbox",
      "aria-multiline": true,
      "aria-label": this.#labelText,
      placeholder: this.getAttribute("placeholder")
    });
    editorContentElement.id = `${this.id}-content`;
    this.#ariaAttributes.forEach(attribute => editorContentElement.setAttribute(attribute.name, attribute.value));
    this.appendChild(editorContentElement);

    if (this.getAttribute("tabindex")) {
      editorContentElement.setAttribute("tabindex", this.getAttribute("tabindex"));
      this.removeAttribute("tabindex");
    } else {
      editorContentElement.setAttribute("tabindex", 0);
    }

    return editorContentElement
  }

  get #labelText() {
    return Array.from(this.internals.labels).map(label => label.textContent).join(" ")
  }

  get #ariaAttributes() {
    return Array.from(this.attributes).filter(attribute => attribute.name.startsWith("aria-"))
  }

  set #internalFormValue(html) {
    const changed = this.#internalFormValue !== undefined && this.#internalFormValue !== this.value;

    this.internals.setFormValue(html);
    this._internalFormValue = html;
    this.#validationTextArea.value = this.isEmpty ? "" : html;

    if (changed) {
      dispatch(this, "lexxy:change");
    }
  }

  get #internalFormValue() {
    return this._internalFormValue
  }

  #loadInitialValue() {
    const initialHtml = this.valueBeforeDisconnect || this.getAttribute("value") || "<p></p>";
    this.value = this.#initialValue = initialHtml;
  }

  #resetBeforeTurboCaches() {
    document.addEventListener("turbo:before-cache", this.#handleTurboBeforeCache);
  }

  #handleTurboBeforeCache = (event) => {
    this.#reset();
  }

  #synchronizeWithChanges() {
    this.#addUnregisterHandler(this.editor.registerUpdateListener(({ editorState }) => {
      this.#clearCachedValues();
      this.#internalFormValue = this.value;
      this.#toggleEmptyStatus();
      this.#setValidity();
    }));
  }

  #clearCachedValues() {
    this.cachedValue = null;
    this.cachedStringValue = null;
  }

  #addUnregisterHandler(handler) {
    this.unregisterHandlers = this.unregisterHandlers || [];
    this.unregisterHandlers.push(handler);
  }

  #unregisterHandlers() {
    this.unregisterHandlers?.forEach((handler) => {
      handler();
    });
    this.unregisterHandlers = null;
  }

  #registerComponents() {
    registerRichText(this.editor);
    this.historyState = createEmptyHistoryState();
    registerHistory(this.editor, this.historyState, 20);
    registerList(this.editor);
    this.#registerTableComponents();
    this.#registerCodeHiglightingComponents();
    registerMarkdownShortcuts(this.editor, TRANSFORMERS);
  }

  #registerTableComponents() {
    registerTablePlugin(this.editor);
    this.tableHandler = createElement("lexxy-table-handler");
    this.append(this.tableHandler);
  }

  #registerCodeHiglightingComponents() {
    registerCodeHighlighting(this.editor);
    this.codeLanguagePicker = createElement("lexxy-code-language-picker");
    this.append(this.codeLanguagePicker);
  }

  #listenForInvalidatedNodes() {
    this.editor.getRootElement().addEventListener("lexxy:internal:invalidate-node", (event) => {
      const { key, values } = event.detail;

      this.editor.update(() => {
        const node = $getNodeByKey(key);

        if (node instanceof ActionTextAttachmentNode) {
          const updatedNode = node.getWritable();
          Object.assign(updatedNode, values);
        }
      });
    });
  }

  #handleEnter() {
    // We can't prevent these externally using regular keydown because Lexical handles it first.
    this.editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        // Prevent CTRL+ENTER
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          return true
        }

        // In single line mode, prevent ENTER
        if (this.isSingleLineMode) {
          event.preventDefault();
          return true
        }

        return false
      },
      COMMAND_PRIORITY_NORMAL
    );
  }

  #handleFocus() {
    // Lexxy handles focus and blur as commands
    // see https://github.com/facebook/lexical/blob/d1a8e84fe9063a4f817655b346b6ff373aa107f0/packages/lexical/src/LexicalEvents.ts#L35
    // and https://stackoverflow.com/a/72212077
    this.editor.registerCommand(BLUR_COMMAND, () => { dispatch(this, "lexxy:blur"); }, COMMAND_PRIORITY_NORMAL);
    this.editor.registerCommand(FOCUS_COMMAND, () => { dispatch(this, "lexxy:focus"); }, COMMAND_PRIORITY_NORMAL);
  }

  #handleTables() {
    this.removeTableSelectionObserver = registerTableSelectionObserver(this.editor, true);
    setScrollableTablesActive(this.editor, true);
  }

  #attachDebugHooks() {
    if (!LexicalEditorElement.debug) return

    this.#addUnregisterHandler(this.editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        console.debug("HTML: ", this.value, "String:", this.toString());
        console.debug("empty", this.isEmpty, "blank", this.isBlank);
      });
    }));
  }

  #attachToolbar() {
    if (this.#hasToolbar) {
      this.toolbarElement.setEditor(this);
    }
  }

  #findOrCreateDefaultToolbar() {
    const toolbarId = this.getAttribute("toolbar");
    return toolbarId ? document.getElementById(toolbarId) : this.#createDefaultToolbar()
  }

  get #hasToolbar() {
    return this.getAttribute("toolbar") !== "false"
  }

  #createDefaultToolbar() {
    const toolbar = createElement("lexxy-toolbar");
    toolbar.innerHTML = LexicalToolbarElement.defaultTemplate;
    toolbar.setAttribute("data-attachments", this.supportsAttachments); // Drives toolbar CSS styles
    this.prepend(toolbar);
    return toolbar
  }

  #toggleEmptyStatus() {
    this.classList.toggle("lexxy-editor--empty", this.isEmpty);
  }

  #setValidity() {
    if (this.#validationTextArea.validity.valid) {
      this.internals.setValidity({});
    } else {
      this.internals.setValidity(this.#validationTextArea.validity, this.#validationTextArea.validationMessage, this.editorContentElement);
    }
  }

  #reset() {
    this.#unregisterHandlers();

    if (this.editorContentElement) {
      this.editorContentElement.remove();
      this.editorContentElement = null;
    }

    this.contents = null;
    this.editor = null;

    if (this.toolbar) {
      if (!this.getAttribute("toolbar")) { this.toolbar.remove(); }
      this.toolbar = null;
    }

    if (this.codeLanguagePicker) {
      this.codeLanguagePicker.remove();
      this.codeLanguagePicker = null;
    }

    if (this.tableHandler) {
      this.tableHandler.remove();
      this.tableHandler = null;
    }

    this.selection = null;

    document.removeEventListener("turbo:before-cache", this.#handleTurboBeforeCache);
  }

  #reconnect() {
    this.disconnectedCallback();
    this.valueBeforeDisconnect = null;
    this.connectedCallback();
  }
}

customElements.define("lexxy-editor", LexicalEditorElement);

class ToolbarDropdown extends HTMLElement {
  connectedCallback() {
    this.container = this.closest("details");

    this.container.addEventListener("toggle", this.#handleToggle.bind(this));
    this.container.addEventListener("keydown", this.#handleKeyDown.bind(this));

    this.#setTabIndexValues();
  }

  disconnectedCallback() {
    this.#removeClickOutsideHandler();
    this.container.removeEventListener("keydown", this.#handleKeyDown.bind(this));
  }

  get toolbar() {
    return this.closest("lexxy-toolbar")
  }

  get editor() {
    return this.toolbar.editor
  }

  close() {
    this.container.removeAttribute("open");
  }

  #handleToggle(event) {
    if (this.container.open) {
      this.#handleOpen(event.target);
    } else {
      this.#handleClose();
    }
  }

  #handleOpen(trigger) {
    this.trigger = trigger;
    this.#interactiveElements[0].focus();
    this.#setupClickOutsideHandler();
  }

  #handleClose() {
    this.trigger = null;
    this.#removeClickOutsideHandler();
    this.editor.focus();
  }

  #setupClickOutsideHandler() {
    if (this.clickOutsideHandler) return

    this.clickOutsideHandler = this.#handleClickOutside.bind(this);
    document.addEventListener("click", this.clickOutsideHandler, true);
  }

  #removeClickOutsideHandler() {
    if (!this.clickOutsideHandler) return

    document.removeEventListener("click", this.clickOutsideHandler, true);
    this.clickOutsideHandler = null;
  }

  #handleClickOutside({ target }) {
    if (this.container.open && !this.container.contains(target)) this.close();
  }

  #handleKeyDown(event) {
    if (event.key === "Escape") {
      event.stopPropagation();
      this.close();
    }
  }

  async #setTabIndexValues() {
    await nextFrame();
    this.#interactiveElements.forEach((element) => {
      element.setAttribute("tabindex", 0);
    });
  }

  get #interactiveElements() {
    return Array.from(this.querySelectorAll("button, input"))
  }
}

class LinkDropdown extends ToolbarDropdown {
  connectedCallback() {
    super.connectedCallback();
    this.input = this.querySelector("input");

    this.#registerHandlers();
  }

  #registerHandlers() {
    this.container.addEventListener("toggle", this.#handleToggle.bind(this));
    this.addEventListener("submit", this.#handleSubmit.bind(this));
    this.querySelector("[value='unlink']").addEventListener("click", this.#handleUnlink.bind(this));
  }

  #handleToggle({ newState }) {
    this.input.value = this.#selectedLinkUrl;
    this.input.required = newState === "open";
  }

  #handleSubmit(event) {
    const command = event.submitter?.value;
    this.editor.dispatchCommand(command, this.input.value);
    this.close();
  }

  #handleUnlink() {
    this.editor.dispatchCommand("unlink");
    this.close();
  }

  get #selectedLinkUrl() {
    let url = "";

    this.editor.getEditorState().read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return

      let node = selection.getNodes()[0];
      while (node && node.getParent()) {
        if ($isLinkNode(node)) {
          url = node.getURL();
          break
        }
        node = node.getParent();
      }
    });

    return url
  }
}

customElements.define("lexxy-link-dropdown", LinkDropdown);

const APPLY_HIGHLIGHT_SELECTOR = "button.lexxy-highlight-button";
const REMOVE_HIGHLIGHT_SELECTOR = "[data-command='removeHighlight']";

// Use Symbol instead of null since $getSelectionStyleValueForProperty
// responds differently for backward selections if null is the default
// see https://github.com/facebook/lexical/issues/8013
const NO_STYLE = Symbol("no_style");

class HighlightDropdown extends ToolbarDropdown {
  connectedCallback() {
    super.connectedCallback();

    this.#setUpButtons();
    this.#registerHandlers();
  }

  #registerHandlers() {
    this.container.addEventListener("toggle", this.#handleToggle.bind(this));
    this.#colorButtons.forEach(button => button.addEventListener("click", this.#handleColorButtonClick.bind(this)));
    this.querySelector(REMOVE_HIGHLIGHT_SELECTOR).addEventListener("click", this.#handleRemoveHighlightClick.bind(this));
  }

  #setUpButtons() {
    this.#buttonGroups.forEach(buttonGroup => {
      this.#populateButtonGroup(buttonGroup);
    });
  }

  #populateButtonGroup(buttonGroup) {
    const values = buttonGroup.dataset.values?.split("; ") || [];
    const attribute = buttonGroup.dataset.buttonGroup;
    values.forEach((value, index) => {
      buttonGroup.appendChild(this.#createButton(attribute, value, index));
    });
  }

  #createButton(attribute, value, index) {
    const button = document.createElement("button");
    button.dataset.style = attribute;
    button.style.setProperty(attribute, value);
    button.dataset.value = value;
    button.classList.add("lexxy-highlight-button");
    button.name = attribute + "-" + index;
    return button
  }

  #handleToggle({ newState }) {
    if (newState === "open") {
      this.editor.getEditorState().read(() => {
        this.#updateColorButtonStates($getSelection());
      });
    }
  }

  #handleColorButtonClick(event) {
    event.preventDefault();

    const button = event.target.closest(APPLY_HIGHLIGHT_SELECTOR);
    if (!button) return

    const attribute = button.dataset.style;
    const value = button.dataset.value;

    this.editor.dispatchCommand("toggleHighlight", { [attribute]: value });
    this.close();
  }

  #handleRemoveHighlightClick(event) {
    event.preventDefault();

    this.editor.dispatchCommand("removeHighlight");
    this.close();
  }

  #updateColorButtonStates(selection) {
    if (!$isRangeSelection(selection)) { return }

    // Use non-"" default, so "" indicates mixed highlighting
    const textColor = $getSelectionStyleValueForProperty(selection, "color", NO_STYLE);
    const backgroundColor = $getSelectionStyleValueForProperty(selection, "background-color", NO_STYLE);

    this.#colorButtons.forEach(button => {
      const matchesSelection = button.dataset.value === textColor || button.dataset.value === backgroundColor;
      button.setAttribute("aria-pressed", matchesSelection);
    });

    const hasHighlight = textColor !== NO_STYLE || backgroundColor !== NO_STYLE;
    this.querySelector(REMOVE_HIGHLIGHT_SELECTOR).disabled = !hasHighlight;
  }

  get #buttonGroups() {
    return this.querySelectorAll("[data-button-group]")
  }

  get #colorButtons() {
    return Array.from(this.querySelectorAll(APPLY_HIGHLIGHT_SELECTOR))
  }
}

customElements.define("lexxy-highlight-dropdown", HighlightDropdown);

class TableHandler extends HTMLElement {
  connectedCallback() {
    this.#setUpButtons();
    this.#monitorForTableSelection();
    this.#registerKeyboardShortcuts();
  }

  disconnectedCallback() {
    this.#unregisterKeyboardShortcuts();
  }

  get #editor() {
    return this.#editorElement.editor
  }

  get #editorElement() {
    return this.closest("lexxy-editor")
  }

  get #currentCell() {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return null

    const anchorNode = selection.anchor.getNode();
    return $getTableCellNodeFromLexicalNode(anchorNode)
  }

  get #currentRow() {
    const currentCell = this.#currentCell;
    if (!currentCell) return 0
    return $getTableRowIndexFromTableCellNode(currentCell)
  }

  get #currentColumn() {
    const currentCell = this.#currentCell;
    if (!currentCell) return 0
    return $getTableColumnIndexFromTableCellNode(currentCell)
  }

  #registerKeyboardShortcuts() {
    this.unregisterKeyboardShortcuts = this.#editor.registerCommand(KEY_DOWN_COMMAND, this.#handleKeyDown.bind(this), COMMAND_PRIORITY_HIGH);
  }

  #unregisterKeyboardShortcuts() {
    this.unregisterKeyboardShortcuts();
  }

  #handleKeyDown(event) {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === "F10") {
      const firstButton = this.buttonsContainer?.querySelector("button, [tabindex]:not([tabindex='-1'])");
      this.#setFocusStateOnSelectedCell();
      firstButton?.focus();
    } else if (event.key === "Escape") {
      this.#editor.getEditorState().read(() => {
        const cell = this.#currentCell;
        if (!cell) return

        this.#editor.update(() => {
          cell.select();
        });
      });
      this.#closeMoreMenu();
    }
  }

  #setUpButtons() {
    this.buttonsContainer = createElement("div", {
      className: "lexxy-table-handle-buttons"
    });

    this.buttonsContainer.appendChild(this.#createRowButtonsContainer());
    this.buttonsContainer.appendChild(this.#createColumnButtonsContainer());

    this.moreMenu = this.#createMoreMenu();
    this.buttonsContainer.appendChild(this.moreMenu);

    this.#editorElement.appendChild(this.buttonsContainer);
  }

  #showTableHandlerButtons() {
    this.buttonsContainer.style.display = "flex";
    this.#closeMoreMenu();

    this.#updateRowColumnCount();
    this.#setTableFocusState(true);
  }

  #hideTableHandlerButtons() {
    this.buttonsContainer.style.display = "none";
    this.#closeMoreMenu();

    this.#setTableFocusState(false);
    this.currentTableNode = null;
  }

  #updateButtonsPosition(tableNode) {
    const tableElement = this.#editor.getElementByKey(tableNode.getKey());
    if (!tableElement) return

    const tableRect = tableElement.getBoundingClientRect();
    const editorRect = this.#editorElement.getBoundingClientRect();

    const relativeTop = tableRect.top - editorRect.top;
    const relativeCenter = (tableRect.left + tableRect.right) / 2 - editorRect.left;
    this.buttonsContainer.style.top = `${relativeTop}px`;
    this.buttonsContainer.style.left = `${relativeCenter}px`;
  }

  #updateRowColumnCount() {
    if (!this.currentTableNode) return

    const tableElement = $getElementForTableNode(this.#editor, this.currentTableNode);
    if (!tableElement) return

    const rowCount = tableElement.rows;
    const columnCount = tableElement.columns;

    this.rowCount.textContent = `${rowCount} row${rowCount === 1 ? "" : "s"}`;
    this.columnCount.textContent = `${columnCount} column${columnCount === 1 ? "" : "s"}`;
  }

  #createButton(icon, label, onClick) {
    const button = createElement("button", {
      className: "lexxy-table-control__button",
      "aria-label": label,
      type: "button"
    });
    button.tabIndex = -1;
    button.innerHTML = `${icon} <span>${label}</span>`;
    button.addEventListener("click", onClick.bind(this));

    return button
  }

  #createRowButtonsContainer() {
    const container = createElement("div", { className: "lexxy-table-control" });

    const plusButton = this.#createButton("+", "Add row", () => this.#insertTableRow("end"));
    const minusButton = this.#createButton("−", "Remove row", () => this.#deleteTableRow("end"));

    this.rowCount = createElement("span");
    this.rowCount.textContent = "_ rows";

    container.appendChild(minusButton);
    container.appendChild(this.rowCount);
    container.appendChild(plusButton);

    return container
  }

  #createColumnButtonsContainer() {
    const container = createElement("div", { className: "lexxy-table-control" });

    const plusButton = this.#createButton("+", "Add column", () => this.#insertTableColumn("end"));
    const minusButton = this.#createButton("−", "Remove column", () => this.#deleteTableColumn("end"));

    this.columnCount = createElement("span");
    this.columnCount.textContent = "_ columns";

    container.appendChild(minusButton);
    container.appendChild(this.columnCount);
    container.appendChild(plusButton);

    return container
  }

  #createMoreMenu() {
    const container = createElement("details", {
      className: "lexxy-table-control lexxy-table-control__more-menu"
    });

    container.tabIndex = -1;

    const summary = createElement("summary", {}, "•••");
    container.appendChild(summary);

    const details = createElement("div", { className: "lexxy-table-control__more-menu-details" });
    container.appendChild(details);

    details.appendChild(this.#createRowSection());
    details.appendChild(this.#createColumnSection());
    details.appendChild(this.#createDeleteTableSection());

    container.addEventListener("toggle", this.#handleMoreMenuToggle.bind(this));

    return container
  }

  #createColumnSection() {
    const columnSection = createElement("section", { className: "lexxy-table-control__more-menu-section" });

    const columnButtons = [
      { icon: this.#icon("add-column-before"), label: "Add column before", onClick: () => this.#insertTableColumn("left") },
      { icon: this.#icon("add-column-after"), label: "Add column after", onClick: () => this.#insertTableColumn("right") },
      { icon: this.#icon("remove-column"), label: "Remove column", onClick: this.#deleteTableColumn },
      { icon: this.#icon("toggle-column-style"), label: "Toggle column style", onClick: this.#toggleColumnHeaderStyle },
    ];

    columnButtons.forEach(button => {
      const buttonElement = this.#createButton(button.icon, button.label, button.onClick);
      columnSection.appendChild(buttonElement);
    });

    return columnSection
  }

  #createRowSection() {
    const rowSection = createElement("section", { className: "lexxy-table-control__more-menu-section" });

    const rowButtons = [
      { icon: this.#icon("add-row-above"), label: "Add row above", onClick: () => this.#insertTableRow("above") },
      { icon: this.#icon("add-row-below"), label: "Add row below", onClick: () => this.#insertTableRow("below") },
      { icon: this.#icon("remove-row"), label: "Remove row", onClick: this.#deleteTableRow },
      { icon: this.#icon("toggle-row-style"), label: "Toggle row style", onClick: this.#toggleRowHeaderStyle }
    ];

    rowButtons.forEach(button => {
      const buttonElement = this.#createButton(button.icon, button.label, button.onClick);
      rowSection.appendChild(buttonElement);
    });

    return rowSection
  }

  #createDeleteTableSection() {
    const deleteSection = createElement("section", { className: "lexxy-table-control__more-menu-section" });

    const deleteButton = { icon: this.#icon("delete-table"), label: "Delete table", onClick: this.#deleteTable };

    const buttonElement = this.#createButton(deleteButton.icon, deleteButton.label, deleteButton.onClick);
    deleteSection.appendChild(buttonElement);

    return deleteSection
  }

  #handleMoreMenuToggle() {
    if (this.moreMenu.open) {
      this.#setFocusStateOnSelectedCell();
    } else {
      this.#removeFocusStateFromSelectedCell();
    }
  }

  #closeMoreMenu() {
    this.#removeFocusStateFromSelectedCell();
    this.moreMenu.removeAttribute("open");
  }

  #monitorForTableSelection() {
    this.#editor.registerUpdateListener(() => {
      this.#editor.getEditorState().read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return

        const anchorNode = selection.anchor.getNode();
        const tableNode = $findTableNode(anchorNode);

        if (tableNode) {
          this.#tableCellWasSelected(tableNode);
        } else {
          this.#hideTableHandlerButtons();
        }
      });
    });
  }

  #setTableFocusState(focused) {
    this.#editorElement.querySelector("div.node--selected:has(table)")?.classList.remove("node--selected");

    if (focused && this.currentTableNode) {
      const tableParent = this.#editor.getElementByKey(this.currentTableNode.getKey());
      if (!tableParent) return
      tableParent.classList.add("node--selected");
    }
  }

  #tableCellWasSelected(tableNode) {
    this.currentTableNode = tableNode;
    this.#updateButtonsPosition(tableNode);
    this.#showTableHandlerButtons();
  }

  #setFocusStateOnSelectedCell() {
    this.#editor.getEditorState().read(() => {
      const currentCell = this.#currentCell;
      if (!currentCell) return

      const cellElement = this.#editor.getElementByKey(currentCell.getKey());
      if (!cellElement) return

      cellElement.classList.add("table-cell--selected");
    });
  }

  #removeFocusStateFromSelectedCell() {
    this.#editorElement.querySelector(".table-cell--selected")?.classList.remove("table-cell--selected");
  }

  #selectLastTableCell() {
    if (!this.currentTableNode) return

    const last = this.currentTableNode.getLastChild().getLastChild();
    if (!$isTableCellNode(last)) return

    last.selectEnd();
  }

  #deleteTable() {
    this.#editor.dispatchCommand("deleteTable");

    this.#closeMoreMenu();
    this.#updateRowColumnCount();
  }

  #insertTableRow(direction) {
    this.#executeTableCommand("insert", "row", direction);
  }

  #insertTableColumn(direction) {
    this.#executeTableCommand("insert", "column", direction);
  }

  #deleteTableRow(direction) {
    this.#executeTableCommand("delete", "row", direction);
  }

  #deleteTableColumn(direction) {
    this.#executeTableCommand("delete", "column", direction);
  }

  #executeTableCommand(action = "insert", childType = "row", direction) {
    this.#editor.update(() => {
      const currentCell = this.#currentCell;
      if (!currentCell) return

      if (direction === "end") {
        this.#selectLastTableCell();
      }

      this.#dispatchTableCommand(action, childType, direction);

      if (currentCell.isAttached()) {
        currentCell.selectEnd();
      }
    });

    this.#closeMoreMenu();
    this.#updateRowColumnCount();
  }

  #dispatchTableCommand(action, childType, direction) {
    switch (action) {
      case "insert":
        switch (childType) {
          case "row":
            if (direction === "above") {
              this.#editor.dispatchCommand("insertTableRowAbove");
            } else {
              this.#editor.dispatchCommand("insertTableRowBelow");
            }
            break
          case "column":
            if (direction === "left") {
              this.#editor.dispatchCommand("insertTableColumnBefore");
            } else {
              this.#editor.dispatchCommand("insertTableColumnAfter");
            }
            break
        }
        break
      case "delete":
        switch (childType) {
          case "row":
            this.#editor.dispatchCommand("deleteTableRow");
            break
          case "column":
            this.#editor.dispatchCommand("deleteTableColumn");
            break
        }
        break
    }
  }

  #toggleRowHeaderStyle() {
    this.#editor.update(() => {
      const rows = this.currentTableNode.getChildren();

      const row = rows[this.#currentRow];
      if (!row) return

      const cells = row.getChildren();
      const firstCell = $getTableCellNodeFromLexicalNode(cells[0]);
      if (!firstCell) return

      const currentStyle = firstCell.getHeaderStyles();
      const newStyle = currentStyle ^ TableCellHeaderStates.ROW;

      cells.forEach(cell => {
        this.#setHeaderStyle(cell, newStyle, TableCellHeaderStates.ROW);
      });
    });
  }

  #toggleColumnHeaderStyle() {
    this.#editor.update(() => {
      const rows = this.currentTableNode.getChildren();

      const row = rows[this.#currentRow];
      if (!row) return

      const cells = row.getChildren();
      const selectedCell = $getTableCellNodeFromLexicalNode(cells[this.#currentColumn]);
      if (!selectedCell) return

      const currentStyle = selectedCell.getHeaderStyles();
      const newStyle = currentStyle ^ TableCellHeaderStates.COLUMN;

      rows.forEach(row => {
        const cell = row.getChildren()[this.#currentColumn];
        if (!cell) return
        this.#setHeaderStyle(cell, newStyle, TableCellHeaderStates.COLUMN);
      });
    });
  }

  #setHeaderStyle(cell, newStyle, headerState) {
    const tableCellNode = $getTableCellNodeFromLexicalNode(cell);

    if (tableCellNode) {
      tableCellNode.setHeaderStyles(newStyle, headerState);
    }
  }

  #icon(name) {
    const icons =
      {
        "add-row-above":
          `<svg viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
          <path d="M4 7L0 10V4L4 7ZM6.5 7.5H16.5V6.5H6.5V7.5ZM18 8C18 8.55228 17.5523 9 17 9H6C5.44772 9 5 8.55228 5 8V6C5 5.44772 5.44772 5 6 5H17C17.5523 5 18 5.44772 18 6V8Z"/><path d="M2 2C2 1.44772 2.44772 1 3 1H15C15.5523 1 16 1.44772 16 2C16 2.55228 15.5523 3 15 3H3C2.44772 3 2 2.55228 2 2Z"/><path d="M2 12C2 11.4477 2.44772 11 3 11H15C15.5523 11 16 11.4477 16 12C16 12.5523 15.5523 13 15 13H3C2.44772 13 2 12.5523 2 12Z"/><path d="M2 16C2 15.4477 2.44772 15 3 15H15C15.5523 15 16 15.4477 16 16C16 16.5523 15.5523 17 15 17H3C2.44772 17 2 16.5523 2 16Z"/>
          </svg>`,

        "add-row-below":
          `<svg viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
          <path d="M4 11L0 8V14L4 11ZM6.5 10.5H16.5V11.5H6.5V10.5ZM18 10C18 9.44772 17.5523 9 17 9H6C5.44772 9 5 9.44772 5 10V12C5 12.5523 5.44772 13 6 13H17C17.5523 13 18 12.5523 18 12V10Z"/><path d="M2 16C2 16.5523 2.44772 17 3 17H15C15.5523 17 16 16.5523 16 16C16 15.4477 15.5523 15 15 15H3C2.44772 15 2 15.4477 2 16Z"/><path d="M2 6C2 6.55228 2.44772 7 3 7H15C15.5523 7 16 6.55228 16 6C16 5.44772 15.5523 5 15 5H3C2.44772 5 2 5.44772 2 6Z"/><path d="M2 2C2 2.55228 2.44772 3 3 3H15C15.5523 3 16 2.55228 16 2C16 1.44772 15.5523 1 15 1H3C2.44772 1 2 1.44772 2 2Z"/>
          </svg>`,

        "remove-row":
          `<svg viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
          <path d="M17.9951 10.1025C17.9438 10.6067 17.5177 11 17 11H12.4922L13.9922 9.5H16.5V5.5L1.5 5.5L1.5 9.5H4.00586L5.50586 11H1L0.897461 10.9951C0.427034 10.9472 0.0527828 10.573 0.00488281 10.1025L0 10L1.78814e-07 5C2.61831e-07 4.48232 0.393332 4.05621 0.897461 4.00488L1 4L17 4C17.5523 4 18 4.44772 18 5V10L17.9951 10.1025Z"/><path d="M11.2969 15.0146L8.99902 12.7168L6.7002 15.0146L5.63965 13.9541L7.93848 11.6562L5.63965 9.3584L6.7002 8.29785L8.99902 10.5957L11.2969 8.29785L12.3574 9.3584L10.0596 11.6562L12.3574 13.9541L11.2969 15.0146Z"/>
          </svg>`,

        "toggle-row-style":
          `<svg viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
          <path d="M1 2C1 1.44772 1.44772 1 2 1H7C7.55228 1 8 1.44772 8 2V7C8 7.55228 7.55228 8 7 8H2C1.44772 8 1 7.55228 1 7V2Z"/><path d="M2.5 15.5H6.5V11.5H2.5V15.5ZM8 16C8 16.5177 7.60667 16.9438 7.10254 16.9951L7 17H2L1.89746 16.9951C1.42703 16.9472 1.05278 16.573 1.00488 16.1025L1 16V11C1 10.4477 1.44772 10 2 10H7C7.55228 10 8 10.4477 8 11V16Z"/><path d="M10 2C10 1.44772 10.4477 1 11 1H16C16.5523 1 17 1.44772 17 2V7C17 7.55228 16.5523 8 16 8H11C10.4477 8 10 7.55228 10 7V2Z"/><path d="M11.5 15.5H15.5V11.5H11.5V15.5ZM17 16C17 16.5177 16.6067 16.9438 16.1025 16.9951L16 17H11L10.8975 16.9951C10.427 16.9472 10.0528 16.573 10.0049 16.1025L10 16V11C10 10.4477 10.4477 10 11 10H16C16.5523 10 17 10.4477 17 11V16Z"/>
          </svg>`,

        "add-column-before":
          `<svg viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
          <path d="M7 4L10 2.62268e-07L4 0L7 4ZM7.5 6.5L7.5 16.5H6.5L6.5 6.5H7.5ZM8 18C8.55228 18 9 17.5523 9 17V6C9 5.44772 8.55229 5 8 5H6C5.44772 5 5 5.44772 5 6L5 17C5 17.5523 5.44772 18 6 18H8Z"/><path d="M2 2C1.44772 2 1 2.44772 1 3L1 15C1 15.5523 1.44772 16 2 16C2.55228 16 3 15.5523 3 15L3 3C3 2.44772 2.55229 2 2 2Z"/><path d="M12 2C11.4477 2 11 2.44772 11 3L11 15C11 15.5523 11.4477 16 12 16C12.5523 16 13 15.5523 13 15L13 3C13 2.44772 12.5523 2 12 2Z"/><path d="M16 2C15.4477 2 15 2.44772 15 3L15 15C15 15.5523 15.4477 16 16 16C16.5523 16 17 15.5523 17 15V3C17 2.44772 16.5523 2 16 2Z"/>
          </svg>`,

        "add-column-after":
          `<svg viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
          <path d="M11 4L8 2.62268e-07L14 0L11 4ZM10.5 6.5V16.5H11.5V6.5H10.5ZM10 18C9.44772 18 9 17.5523 9 17V6C9 5.44772 9.44772 5 10 5H12C12.5523 5 13 5.44772 13 6V17C13 17.5523 12.5523 18 12 18H10Z"/><path d="M16 2C16.5523 2 17 2.44772 17 3L17 15C17 15.5523 16.5523 16 16 16C15.4477 16 15 15.5523 15 15V3C15 2.44772 15.4477 2 16 2Z"/><path d="M6 2C6.55228 2 7 2.44772 7 3L7 15C7 15.5523 6.55228 16 6 16C5.44772 16 5 15.5523 5 15L5 3C5 2.44772 5.44771 2 6 2Z"/><path d="M2 2C2.55228 2 3 2.44772 3 3L3 15C3 15.5523 2.55228 16 2 16C1.44772 16 1 15.5523 1 15V3C1 2.44772 1.44771 2 2 2Z"/>
          </svg>`,

        "remove-column":
          `<svg viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
          <path d="M10.1025 0.00488281C10.6067 0.0562145 11 0.482323 11 1V5.50781L9.5 4.00781V1.5H5.5V16.5H9.5V13.9941L11 12.4941V17L10.9951 17.1025C10.9472 17.573 10.573 17.9472 10.1025 17.9951L10 18H5C4.48232 18 4.05621 17.6067 4.00488 17.1025L4 17V1C4 0.447715 4.44772 1.61064e-08 5 0H10L10.1025 0.00488281Z"/><path d="M12.7169 8.99999L15.015 11.2981L13.9543 12.3588L11.6562 10.0607L9.35815 12.3588L8.29749 11.2981L10.5956 8.99999L8.29749 6.7019L9.35815 5.64124L11.6562 7.93933L13.9543 5.64124L15.015 6.7019L12.7169 8.99999Z"/>
          </svg>`,

        "toggle-column-style":
          `<svg viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
          <path d="M1 2C1 1.44772 1.44772 1 2 1H7C7.55228 1 8 1.44772 8 2V7C8 7.55228 7.55228 8 7 8H2C1.44772 8 1 7.55228 1 7V2Z"/><path d="M1 11C1 10.4477 1.44772 10 2 10H7C7.55228 10 8 10.4477 8 11V16C8 16.5523 7.55228 17 7 17H2C1.44772 17 1 16.5523 1 16V11Z"/><path d="M11.5 6.5H15.5V2.5H11.5V6.5ZM17 7C17 7.51768 16.6067 7.94379 16.1025 7.99512L16 8H11L10.8975 7.99512C10.427 7.94722 10.0528 7.57297 10.0049 7.10254L10 7V2C10 1.44772 10.4477 1 11 1H16C16.5523 1 17 1.44772 17 2V7Z"/><path d="M11.5 15.5H15.5V11.5H11.5V15.5ZM17 16C17 16.5177 16.6067 16.9438 16.1025 16.9951L16 17H11L10.8975 16.9951C10.427 16.9472 10.0528 16.573 10.0049 16.1025L10 16V11C10 10.4477 10.4477 10 11 10H16C16.5523 10 17 10.4477 17 11V16Z"/>
          </svg>`,

        "delete-table":
          `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M18.2129 19.2305C18.0925 20.7933 16.7892 22 15.2217 22H7.77832C6.21084 22 4.90753 20.7933 4.78711 19.2305L4 9H19L18.2129 19.2305Z"/><path d="M13 2C14.1046 2 15 2.89543 15 4H19C19.5523 4 20 4.44772 20 5V6C20 6.55228 19.5523 7 19 7H4C3.44772 7 3 6.55228 3 6V5C3 4.44772 3.44772 4 4 4H8C8 2.89543 8.89543 2 10 2H13Z"/>
          </svg>`
      };

    return icons[name]
  }
}

customElements.define("lexxy-table-handler", TableHandler);

class BaseSource {
  // Template method to override
  async buildListItems(filter = "") {
    return Promise.resolve([])
  }

  // Template method to override
  promptItemFor(listItem) {
    return null
  }

  // Protected

  buildListItemElementFor(promptItemElement) {
    const template = promptItemElement.querySelector("template[type='menu']");
    const fragment = template.content.cloneNode(true);
    const listItemElement = createElement("li", { role: "option", id: generateDomId("prompt-item"), tabindex: "0" });
    listItemElement.classList.add("lexxy-prompt-menu__item");
    listItemElement.appendChild(fragment);
    return listItemElement
  }

  async loadPromptItemsFromUrl(url) {
    try {
      const response = await fetch(url);
      const html = await response.text();
      const promptItems = parseHtml(html).querySelectorAll("lexxy-prompt-item");
      return Promise.resolve(Array.from(promptItems))
    } catch (error) {
      return Promise.reject(error)
    }
  }
}

class LocalFilterSource extends BaseSource {
  async buildListItems(filter = "") {
    const promptItems = await this.fetchPromptItems();
    return this.#buildListItemsFromPromptItems(promptItems, filter)
  }

  // Template method to override
  async fetchPromptItems(filter) {
    return Promise.resolve([])
  }

  promptItemFor(listItem) {
    return this.promptItemByListItem.get(listItem)
  }

  #buildListItemsFromPromptItems(promptItems, filter) {
    const listItems = [];
    this.promptItemByListItem = new WeakMap();
    promptItems.forEach((promptItem) => {
      const searchableText = promptItem.getAttribute("search");

      if (!filter || filterMatches(searchableText, filter)) {
        const listItem = this.buildListItemElementFor(promptItem);
        this.promptItemByListItem.set(listItem, promptItem);
        listItems.push(listItem);
      }
    });

    return listItems
  }
}

class InlinePromptSource extends LocalFilterSource {
  constructor(inlinePromptItems) {
    super();
    this.inlinePromptItemElements = Array.from(inlinePromptItems);
  }

  async fetchPromptItems() {
    return Promise.resolve(this.inlinePromptItemElements)
  }
}

class DeferredPromptSource extends LocalFilterSource {
  constructor(url) {
    super();
    this.url = url;

    this.fetchPromptItems();
  }

  async fetchPromptItems() {
    this.promptItems ??= await this.loadPromptItemsFromUrl(this.url);

    return Promise.resolve(this.promptItems)
  }
}

const DEBOUNCE_INTERVAL = 200;

class RemoteFilterSource extends BaseSource {
  constructor(url) {
    super();

    this.baseURL = url;
    this.loadAndFilterListItems = debounceAsync(this.fetchFilteredListItems.bind(this), DEBOUNCE_INTERVAL);
  }

  async buildListItems(filter = "") {
    return await this.loadAndFilterListItems(filter)
  }

  promptItemFor(listItem) {
    return this.promptItemByListItem.get(listItem)
  }

  async fetchFilteredListItems(filter) {
    const promptItems = await this.loadPromptItemsFromUrl(this.#urlFor(filter));
    return this.#buildListItemsFromPromptItems(promptItems)
  }

  #urlFor(filter) {
    const url = new URL(this.baseURL, window.location.origin);
    url.searchParams.append("filter", filter);
    return url.toString()
  }

  #buildListItemsFromPromptItems(promptItems) {
    const listItems = [];
    this.promptItemByListItem = new WeakMap();

    for (const promptItem of promptItems) {
      const listItem = this.buildListItemElementFor(promptItem);
      this.promptItemByListItem.set(listItem, promptItem);
      listItems.push(listItem);
    }

    return listItems
  }
}

const NOTHING_FOUND_DEFAULT_MESSAGE = "Nothing found";

class LexicalPromptElement extends HTMLElement {
  constructor() {
    super();
    this.keyListeners = [];
  }

  static observedAttributes = [ "connected" ]

  connectedCallback() {
    this.source = this.#createSource();

    this.#addTriggerListener();
    this.toggleAttribute("connected", true);
  }

  disconnectedCallback() {
    this.source = null;
    this.popoverElement = null;
  }


  attributeChangedCallback(name, oldValue, newValue) {
    if (name === "connected" && this.isConnected && oldValue != null && oldValue !== newValue) {
      requestAnimationFrame(() => this.#reconnect());
    }
  }

  get name() {
    return this.getAttribute("name")
  }

  get trigger() {
    return this.getAttribute("trigger")
  }

  get supportsSpaceInSearches() {
    return this.hasAttribute("supports-space-in-searches")
  }

  get open() {
    return this.popoverElement?.classList?.contains("lexxy-prompt-menu--visible")
  }

  get closed() {
    return !this.open
  }

  get #doesSpaceSelect() {
    return !this.supportsSpaceInSearches
  }

  #createSource() {
    const src = this.getAttribute("src");
    if (src) {
      if (this.hasAttribute("remote-filtering")) {
        return new RemoteFilterSource(src)
      } else {
        return new DeferredPromptSource(src)
      }
    } else {
      return new InlinePromptSource(this.querySelectorAll("lexxy-prompt-item"))
    }
  }

  #addTriggerListener() {
    const unregister = this.#editor.registerUpdateListener(() => {
      this.#editor.read(() => {
        const { node, offset } = this.#selection.selectedNodeWithOffset();
        if (!node) return

        if ($isTextNode(node) && offset > 0) {
          const fullText = node.getTextContent();
          const charBeforeCursor = fullText[offset - 1];

          // Check if trigger is at the start of the text node (new line case) or preceded by space or newline
          if (charBeforeCursor === this.trigger) {
            const isAtStart = offset === 1;

            const charBeforeTrigger = offset > 1 ? fullText[offset - 2] : null;
            const isPrecededBySpaceOrNewline = charBeforeTrigger === " " || charBeforeTrigger === "\n";

            if (isAtStart || isPrecededBySpaceOrNewline) {
              unregister();
              this.#showPopover();
            }
          }
        }
      });
    });
  }

  #addCursorPositionListener() {
    this.cursorPositionListener = this.#editor.registerUpdateListener(() => {
      if (this.closed) return

      this.#editor.read(() => {
        const { node, offset } = this.#selection.selectedNodeWithOffset();
        if (!node) return

        if ($isTextNode(node) && offset > 0) {
          const fullText = node.getTextContent();
          const textBeforeCursor = fullText.slice(0, offset);
          const lastTriggerIndex = textBeforeCursor.lastIndexOf(this.trigger);

          // If trigger is not found, or cursor is at or before the trigger position, hide popover
          if (lastTriggerIndex === -1 || offset <= lastTriggerIndex) {
            this.#hidePopover();
          }
        } else {
          // Cursor is not in a text node or at offset 0, hide popover
          this.#hidePopover();
        }
      });
    });
  }

  #removeCursorPositionListener() {
    if (this.cursorPositionListener) {
      this.cursorPositionListener();
      this.cursorPositionListener = null;
    }
  }

  get #editor() {
    return this.#editorElement.editor
  }

  get #editorElement() {
    return this.closest("lexxy-editor")
  }

  get #selection() {
    return this.#editorElement.selection
  }

  async #showPopover() {
    this.popoverElement ??= await this.#buildPopover();
    this.#resetPopoverPosition();
    await this.#filterOptions();
    this.popoverElement.classList.toggle("lexxy-prompt-menu--visible", true);
    this.#selectFirstOption();

    this.#editorElement.addEventListener("keydown", this.#handleKeydownOnPopover);
    this.#editorElement.addEventListener("lexxy:change", this.#filterOptions);

    this.#registerKeyListeners();
    this.#addCursorPositionListener();
  }

  #registerKeyListeners() {
    // We can't use a regular keydown for Enter as Lexical handles it first
    this.keyListeners.push(this.#editor.registerCommand(KEY_ENTER_COMMAND, this.#handleSelectedOption.bind(this), COMMAND_PRIORITY_HIGH));
    this.keyListeners.push(this.#editor.registerCommand(KEY_TAB_COMMAND, this.#handleSelectedOption.bind(this), COMMAND_PRIORITY_HIGH));

    if (this.#doesSpaceSelect) {
      this.keyListeners.push(this.#editor.registerCommand(KEY_SPACE_COMMAND, this.#handleSelectedOption.bind(this), COMMAND_PRIORITY_HIGH));
    }

    // Register arrow keys with HIGH priority to prevent Lexical's selection handlers from running
    this.keyListeners.push(this.#editor.registerCommand(KEY_ARROW_UP_COMMAND, this.#handleArrowUp.bind(this), COMMAND_PRIORITY_HIGH));
    this.keyListeners.push(this.#editor.registerCommand(KEY_ARROW_DOWN_COMMAND, this.#handleArrowDown.bind(this), COMMAND_PRIORITY_HIGH));
  }

  #handleArrowUp(event) {
    this.#moveSelectionUp();
    event.preventDefault();
    return true
  }

  #handleArrowDown(event) {
    this.#moveSelectionDown();
    event.preventDefault();
    return true
  }

  #selectFirstOption() {
    const firstOption = this.#listItemElements[0];

    if (firstOption) {
      this.#selectOption(firstOption);
    }
  }

  get #listItemElements() {
    return Array.from(this.popoverElement.querySelectorAll(".lexxy-prompt-menu__item"))
  }

  #selectOption(listItem) {
    this.#clearSelection();
    listItem.toggleAttribute("aria-selected", true);
    listItem.scrollIntoView({ block: "nearest", behavior: "smooth" });
    listItem.focus();

    // Preserve selection to prevent cursor jump
    this.#selection.preservingSelection(() => {
      this.#editorElement.focus();
    });

    this.#editorContentElement.setAttribute("aria-controls", this.popoverElement.id);
    this.#editorContentElement.setAttribute("aria-activedescendant", listItem.id);
    this.#editorContentElement.setAttribute("aria-haspopup", "listbox");
  }

  #clearSelection() {
    this.#listItemElements.forEach((item) => { item.toggleAttribute("aria-selected", false); });
    this.#editorContentElement.removeAttribute("aria-controls");
    this.#editorContentElement.removeAttribute("aria-activedescendant");
    this.#editorContentElement.removeAttribute("aria-haspopup");
  }

  #positionPopover() {
    const { x, y, fontSize } = this.#selection.cursorPosition;
    const editorRect = this.#editorElement.getBoundingClientRect();
    const contentRect = this.#editorContentElement.getBoundingClientRect();
    const verticalOffset = contentRect.top - editorRect.top;

    if (!this.popoverElement.hasAttribute("data-anchored")) {
      this.popoverElement.style.left = `${x}px`;
      this.popoverElement.toggleAttribute("data-anchored", true);
    }

    this.popoverElement.style.top = `${y + verticalOffset}px`;
    this.popoverElement.style.bottom = "auto";

    const popoverRect = this.popoverElement.getBoundingClientRect();
    const isClippedAtBottom = popoverRect.bottom > window.innerHeight;

    if (isClippedAtBottom || this.popoverElement.hasAttribute("data-clipped-at-bottom")) {
      this.popoverElement.style.top = `${y + verticalOffset - popoverRect.height - fontSize}px`;
      this.popoverElement.style.bottom = "auto";
      this.popoverElement.toggleAttribute("data-clipped-at-bottom", true);
    }
  }

  #resetPopoverPosition() {
    this.popoverElement.removeAttribute("data-clipped-at-bottom");
    this.popoverElement.removeAttribute("data-anchored");
  }

  async #hidePopover() {
    this.#clearSelection();
    this.popoverElement.classList.toggle("lexxy-prompt-menu--visible", false);
    this.#editorElement.removeEventListener("lexxy:change", this.#filterOptions);
    this.#editorElement.removeEventListener("keydown", this.#handleKeydownOnPopover);

    this.#unregisterKeyListeners();
    this.#removeCursorPositionListener();

    await nextFrame();
    this.#addTriggerListener();
  }

  #unregisterKeyListeners() {
    this.keyListeners.forEach((unregister) => unregister());
    this.keyListeners = [];
  }

  #filterOptions = async () => {
    if (this.initialPrompt) {
      this.initialPrompt = false;
      return
    }

    if (this.#editorContents.containsTextBackUntil(this.trigger)) {
      await this.#showFilteredOptions();
      await nextFrame();
      this.#positionPopover();
    } else {
      this.#hidePopover();
    }
  }

  async #showFilteredOptions() {
    const filter = this.#editorContents.textBackUntil(this.trigger);
    const filteredListItems = await this.source.buildListItems(filter);
    this.popoverElement.innerHTML = "";

    if (filteredListItems.length > 0) {
      this.#showResults(filteredListItems);
    } else {
      this.#showEmptyResults();
    }
    this.#selectFirstOption();
  }

  #showResults(filteredListItems) {
    this.popoverElement.classList.remove("lexxy-prompt-menu--empty");
    this.popoverElement.append(...filteredListItems);
  }

  #showEmptyResults() {
    this.popoverElement.classList.add("lexxy-prompt-menu--empty");
    const el = createElement("li", { innerHTML: this.#emptyResultsMessage });
    el.classList.add("lexxy-prompt-menu__item--empty");
    this.popoverElement.append(el);
  }

  get #emptyResultsMessage() {
    return this.getAttribute("empty-results") || NOTHING_FOUND_DEFAULT_MESSAGE
  }

  #handleKeydownOnPopover = (event) => {
    if (event.key === "Escape") {
      this.#hidePopover();
      this.#editorElement.focus();
      event.stopPropagation();
    }
    // Arrow keys are now handled via Lexical commands with HIGH priority
  }

  #moveSelectionDown() {
    const nextIndex = this.#selectedIndex + 1;
    if (nextIndex < this.#listItemElements.length) this.#selectOption(this.#listItemElements[nextIndex]);
  }

  #moveSelectionUp() {
    const previousIndex = this.#selectedIndex - 1;
    if (previousIndex >= 0) this.#selectOption(this.#listItemElements[previousIndex]);
  }

  get #selectedIndex() {
    return this.#listItemElements.findIndex((item) => item.hasAttribute("aria-selected"))
  }

  get #selectedListItem() {
    return this.#listItemElements[this.#selectedIndex]
  }

  #handleSelectedOption(event) {
    event.preventDefault();
    event.stopPropagation();
    this.#optionWasSelected();
    return true
  }

  #optionWasSelected() {
    this.#replaceTriggerWithSelectedItem();
    this.#hidePopover();
    this.#editorElement.focus();
  }

  #replaceTriggerWithSelectedItem() {
    const promptItem = this.source.promptItemFor(this.#selectedListItem);

    if (!promptItem) { return }

    const template = promptItem.querySelector("template[type='editor']");
    const stringToReplace = `${this.trigger}${this.#editorContents.textBackUntil(this.trigger)}`;

    if (this.hasAttribute("insert-editable-text")) {
      this.#insertTemplateAsEditableText(template, stringToReplace);
    } else {
      this.#insertTemplateAsAttachment(promptItem, template, stringToReplace);
    }
  }

  #insertTemplateAsEditableText(template, stringToReplace) {
    this.#editor.update(() => {
      const nodes = $generateNodesFromDOM(this.#editor, parseHtml(`${template.innerHTML}`));
      this.#editorContents.replaceTextBackUntil(stringToReplace, nodes);
    });
  }

  #insertTemplateAsAttachment(promptItem, template, stringToReplace) {
    this.#editor.update(() => {
      const attachmentNode = new CustomActionTextAttachmentNode({ sgid: promptItem.getAttribute("sgid"), contentType: `application/vnd.actiontext.${this.name}`, innerHtml: template.innerHTML });
      this.#editorContents.replaceTextBackUntil(stringToReplace, attachmentNode);
    });
  }

  get #editorContents() {
    return this.#editorElement.contents
  }

  get #editorContentElement() {
    return this.#editorElement.editorContentElement
  }

  async #buildPopover() {
    const popoverContainer = createElement("ul", { role: "listbox", id: generateDomId("prompt-popover") }); // Avoiding [popover] due to not being able to position at an arbitrary X, Y position.
    popoverContainer.classList.add("lexxy-prompt-menu");
    popoverContainer.style.position = "absolute";
    popoverContainer.setAttribute("nonce", getNonce());
    popoverContainer.append(...await this.source.buildListItems());
    popoverContainer.addEventListener("click", this.#handlePopoverClick);
    this.#editorElement.appendChild(popoverContainer);
    return popoverContainer
  }

  #handlePopoverClick = (event) => {
    const listItem = event.target.closest(".lexxy-prompt-menu__item");
    if (listItem) {
      this.#selectOption(listItem);
      this.#optionWasSelected();
    }
  }

  #reconnect() {
    this.disconnectedCallback();
    this.connectedCallback();
  }
}

customElements.define("lexxy-prompt", LexicalPromptElement);

class CodeLanguagePicker extends HTMLElement {
  connectedCallback() {
    this.editorElement = this.closest("lexxy-editor");
    this.editor = this.editorElement.editor;

    this.#attachLanguagePicker();
    this.#monitorForCodeBlockSelection();
  }

  #attachLanguagePicker() {
    this.languagePickerElement = this.#createLanguagePicker();

    this.languagePickerElement.addEventListener("change", () => {
      this.#updateCodeBlockLanguage(this.languagePickerElement.value);
    });

    this.languagePickerElement.style.position = "absolute";
    this.languagePickerElement.setAttribute("nonce", getNonce());
    this.editorElement.appendChild(this.languagePickerElement);
  }

  #createLanguagePicker() {
    const selectElement = createElement("select", { hidden: true, className: "lexxy-code-language-picker", "aria-label": "Pick a language…", name: "lexxy-code-language" });

    for (const [ value, label ] of Object.entries(this.#languages)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      selectElement.appendChild(option);
    }

    return selectElement
  }

  get #languages() {
    const languages = { ...CODE_LANGUAGE_FRIENDLY_NAME_MAP };

    if (!languages.ruby) languages.ruby = "Ruby";
    if (!languages.php) languages.php = "PHP";
    if (!languages.go) languages.go = "Go";
    if (!languages.bash) languages.bash = "Bash";
    if (!languages.json) languages.json = "JSON";
    if (!languages.diff) languages.diff = "Diff";

    const sortedEntries = Object.entries(languages)
      .sort(([ , a ], [ , b ]) => a.localeCompare(b));

    // Place the "plain" entry first, then the rest of language sorted alphabetically
    const plainIndex = sortedEntries.findIndex(([ key ]) => key === "plain");
    const plainEntry = sortedEntries.splice(plainIndex, 1)[0];
    return Object.fromEntries([ plainEntry, ...sortedEntries ])
  }

  #updateCodeBlockLanguage(language) {
    this.editor.update(() => {
      const codeNode = this.#getCurrentCodeNode();

      if (codeNode) {
        codeNode.setLanguage(language);
      }
    });
  }

  #monitorForCodeBlockSelection() {
    this.editor.registerUpdateListener(() => {
      this.editor.getEditorState().read(() => {
        const codeNode = this.#getCurrentCodeNode();

        if (codeNode) {
          this.#codeNodeWasSelected(codeNode);
        } else {
          this.#hideLanguagePicker();
        }
      });
    });
  }

  #getCurrentCodeNode() {
    const selection = $getSelection();

    if (!$isRangeSelection(selection)) {
      return null
    }

    const anchorNode = selection.anchor.getNode();
    const parentNode = anchorNode.getParent();

    if ($isCodeNode(anchorNode)) {
      return anchorNode
    } else if ($isCodeNode(parentNode)) {
      return parentNode
    }

    return null
  }

  #codeNodeWasSelected(codeNode) {
    const language = codeNode.getLanguage();

    this.#updateLanguagePickerWith(language);
    this.#showLanguagePicker();
    this.#positionLanguagePicker(codeNode);
  }

  #updateLanguagePickerWith(language) {
    if (this.languagePickerElement && language) {
      const normalizedLanguage = normalizeCodeLang(language);
      this.languagePickerElement.value = normalizedLanguage;
    }
  }

  #positionLanguagePicker(codeNode) {
    const codeElement = this.editor.getElementByKey(codeNode.getKey());
    if (!codeElement) return

    const codeRect = codeElement.getBoundingClientRect();
    const editorRect = this.editorElement.getBoundingClientRect();
    const relativeTop = codeRect.top - editorRect.top;

    this.languagePickerElement.style.top = `${relativeTop}px`;
  }

  #showLanguagePicker() {
    this.languagePickerElement.hidden = false;
  }

  #hideLanguagePicker() {
    this.languagePickerElement.hidden = true;
  }
}

customElements.define("lexxy-code-language-picker", CodeLanguagePicker);

function highlightAll() {
  const elements = document.querySelectorAll("pre[data-language]");

  elements.forEach(preElement => {
    highlightElement(preElement);
  });
}

function highlightElement(preElement) {
  const language = preElement.getAttribute("data-language");
  let code = preElement.innerHTML.replace(/<br\s*\/?>/gi, "\n");

  const grammar = Prism.languages?.[language];
  if (!grammar) return

  // unescape HTML entities in the code block
  code = new DOMParser().parseFromString(code, "text/html").body.textContent || "";

  const highlightedHtml = Prism.highlight(code, grammar, language);
  const codeElement = createElement("code", { "data-language": language, innerHTML: highlightedHtml });
  preElement.replaceWith(codeElement);
}

export { highlightAll };
