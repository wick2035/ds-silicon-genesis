export function spaceReport(input:unknown): Record<string,unknown>;
export function updateSpace(previous:unknown,report:unknown,settings:{display:string;confined:boolean}): {next:Record<string,unknown>;change?:{text:string;say:string}};
