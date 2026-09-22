import { Component, input, output } from '@angular/core';

@Component({
  selector: 'pb-virtual-keyboard',
  templateUrl: './virtual-keyboard.component.html',
  styleUrl: './virtual-keyboard.component.scss',
})
export class VirtualKeyboardComponent {
  readonly value = input('');
  readonly maxLength = input(36);
  readonly valueChange = output<string>();

  readonly rows: string[][] = [
    ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
    ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
    ['Z', 'X', 'C', 'V', 'B', 'N', 'M'],
  ];
  readonly extras = ['&', "'", '-', '.', ','];

  shift = true;

  press(ch: string): void {
    const cur = this.value();
    if (cur.length >= this.maxLength()) return;
    const isLetter = /^[A-Z]$/i.test(ch);
    const out = isLetter && !this.shift ? ch.toLowerCase() : ch;
    this.valueChange.emit(cur + out);
    // Sentence case: one capital (start or after space), then lowercase
    if (isLetter && this.shift) this.shift = false;
  }

  space(): void {
    const cur = this.value();
    if (cur.length >= this.maxLength()) return;
    this.valueChange.emit(cur + ' ');
    this.shift = true;
  }

  backspace(): void {
    const cur = this.value();
    if (!cur.length) return;
    this.valueChange.emit(cur.slice(0, -1));
    if (cur.length <= 1) this.shift = true;
  }

  clear(): void {
    this.valueChange.emit('');
    this.shift = true;
  }

  toggleShift(): void {
    this.shift = !this.shift;
  }
}
