class SimpleSelect extends HTMLElement {
  // 1. Explicitly declare properties
  private _select: HTMLSelectElement;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    // Use a non-null assertion (!) because we know we just attached it
    this.shadowRoot!.innerHTML = `
      <style>
        select { padding: 8px; border-radius: 4px; width: 100%; }
      </style>
      <select id="internal-select"></select>
    `;

    // 2. Cast the element to the correct type
    this._select = this.shadowRoot!.getElementById('internal-select') as HTMLSelectElement;
  }

  // Define the shape of your option objects
  set options(data: { value: string; label: string }[]) {
    this._select.innerHTML = data
      .map(opt => `<option value="${opt.value}">${opt.label}</option>`)
      .join('');
  }

  get value(): string {
    return this._select.value;
  }

  set value(val: string) {
    this._select.value = val;
  }

  connectedCallback() {
    this._select.addEventListener('change', () => {
      this.dispatchEvent(new CustomEvent('change', {
        detail: { value: this._select.value },
        bubbles: true,
        composed: true
      }));
    });
  }
}

customElements.define('simple-select', SimpleSelect);