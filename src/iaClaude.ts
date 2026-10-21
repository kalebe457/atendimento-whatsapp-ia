import "dotenv/config";

import Anthropic from "@anthropic-ai/sdk";

import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";

import type { IA } from "./ia.js";

import { camposDosItens, itensDoResumo, listarEmTexto, type ItemPedido } from "./itensPedido.js";

import { valorSeguro } from "./logSeguro.js";

import type {
  Cliente,
  EstadoTriagem,
  MidiaRecebida,
  ResultadoIA,
  ResumoCliente,
  StatusAtendimento,
  TipoMidia,
} from "./tipos.js";

const MODELO = "claude-sonnet-5-5";

const NAO_INFORMADO = "Não informado";

const INATIVIDADE_MS = 20 * 60 * 1000;

/*
 * Limites da chamada à Claude. O padrão do SDK é 10 min por tentativa
 * e 2 novas tentativas: a fila da conversa podia ficar parada ~30 min.
 * Uma resposta da triagem sai em segundos (~150 tokens de saída), então
 * 40 s por tentativa sobra; 1 nova tentativa (o SDK só repete erro de
 * conexão, timeout, 408/409/429 e 5xx). Pior caso ~81 s (2 × 40 s +
 * espera do SDK); depois disso o fallback de sempre manda para HUMANO.
 */
const LIMITES_CLAUDE = { timeout: 40_000, maxRetries: 1 };

const client = new Anthropic(LIMITES_CLAUDE);

/**
 * Limites em uso pelo cliente da Claude (lidos do próprio cliente).
 */
export function configuracaoClienteClaude(): { timeout: number; maxRetries: number } {
  return { timeout: client.timeout, maxRetries: client.maxRetries };
}

/*
 * Ordem da triagem.
 */
const ORDEM_ETAPAS = ["nome", "produto", "quantidade", "observacoes"] as const;

/*
 * Uma etapa sem resposta válida depois de
 * tantas perguntas é pulada.
 */
const MAX_PERGUNTAS_POR_ETAPA = 2;

type EtapaTriagem = (typeof ORDEM_ETAPAS)[number];

/*
 * Schema utilizado pelo Claude.
 *
 * O telefone não é controlado pelo Claude.
 */
const SCHEMA = {
  type: "object",

  properties: {
    resposta: {
      type: "string",

      description:
        "Mensagem que seria adequada ao cliente. Escreva em português, de forma simpática, natural e objetiva. Faça no máximo UMA pergunta por mensagem. O sistema pode substituir essa resposta por uma pergunta fixa da etapa.",
    },

    status: {
      type: "string",

      enum: ["IA", "HUMANO"],

      description:
        "Campo auxiliar. O sistema controla o status final. Use IA durante a triagem e HUMANO quando o cliente pedir explicitamente atendimento humano ou houver situação de risco.",
    },

    resumo: {
      type: "object",

      properties: {
        nome: {
          type: "string",

          description:
            "Nome do cliente, somente se informado. Caso não informe ou não queira informar, use 'Não informado'.",
        },

        produto: {
          type: "string",

          description:
            "Produto ou interesse do cliente, como ele descreveu: produto, marca, modelo, material, uma pergunta sobre um item ou o que ele precisa resolver. Use somente o que o cliente escreveu. Nunca recomende um produto. Inclua aqui também os produtos que o cliente citar depois, em qualquer etapa (inclusive na resposta das observações).",
        },

        quantidade: {
          type: "string",

          description:
            "Quantidade realmente informada pelo cliente. Nunca estime. Com vários itens, a quantidade de cada um (ex.: '10 sacos de cimento, 2 m³ de areia').",
        },

        observacoes: {
          type: "string",

          description:
            "Só o que não cabe em produto ou quantidade (por exemplo prazo, entrega, ambiente, medidas, forma de pagamento). Nunca repita aqui produtos ou quantidades: eles vão nos campos próprios. Se não sobrar nada, use 'Não informado'. Se o cliente disser que não possui observações, use 'Nenhuma observação adicional.'.",
        },
      },

      required: ["nome", "produto", "quantidade", "observacoes"],

      additionalProperties: false,
    },

    quantidade_aplicavel: {
      type: "boolean",

      description:
        "true quando faz sentido perguntar a quantidade para o que o cliente procura (inclusive com vários itens). false só quando a quantidade realmente não se aplica (por exemplo, serviço ou dúvida geral sobre um item ou marca).",
    },

    produto_generico: {
      type: "boolean",

      description:
        "true quando o cliente disse só uma categoria ou algo vago, sem nenhum item específico (ex.: 'materiais elétricos', 'material hidráulico', 'material de construção', 'coisas pra obra', 'várias coisas'). false quando há pelo menos um item específico ou ainda não há produto.",
    },

    pergunta_itens: {
      type: "string",

      description:
        "Só quando produto_generico for true: UMA pergunta curta pedindo os itens, com exemplos da categoria (ex.: 'Quais materiais elétricos você precisa? Por exemplo: fios, tomadas, disjuntores, lâmpadas.'). Sem preço, estoque ou recomendação. Caso contrário, string vazia.",
    },

    varios_itens: {
      type: "boolean",

      description:
        "true quando o pedido tem mais de um item específico (ex.: 'cimento e areia'). false caso contrário.",
    },

    itens: {
      type: "array",

      description:
        "TODOS os itens do pedido até agora (inclusive os já registrados no resumo atual), um por produto, na ordem em que o cliente citou. Vazio se ainda não há produto.",

      items: {
        type: "object",

        properties: {
          produto: {
            type: "string",

            description:
              "O produto com as características que o cliente deu (tamanho, marca, medida, modelo), ex.: 'caixa d'água de 500 litros', 'cimento CP-II'.",
          },

          quantidade: {
            type: "string",

            description:
              "Só quantas unidades ou quanto (ex.: '10 sacos', '2 m³', '1 unidade'). Característica do produto (ex.: '500 litros' de uma caixa d'água) NÃO é quantidade. '' quando não informada.",
          },
        },

        required: ["produto", "quantidade"],

        additionalProperties: false,
      },
    },

    classificacao_resposta_nome: {
      anyOf: [{ type: "string", enum: ["nome_pessoa", "produto", "outro"] }, { type: "null" }],

      description: "Etapa do nome: o que é a mensagem. Senão, null.",
    },

    pergunta_comercial: {
      anyOf: [{ type: "string", enum: ["disponibilidade", "preco", "prazo", "pagamento", "outra"] }, { type: "null" }],

      description: "Pergunta da mensagem atual que só o vendedor responde (estoque, preço, prazo, pagamento, outra). Sem pergunta assim, null.",
    },

    pedido_atendente: {
      type: "boolean",

      description: "true quando a mensagem atual pede para falar com uma pessoa (atendente, vendedor, humano, 'não quero robô'). Senão, false.",
    },

    acompanhamento: {
      type: "boolean",

      description: "true quando a mensagem atual fala de um orçamento, pedido ou atendimento que já existe (número de orçamento, cobrança de retorno do vendedor, entrega ou pagamento de pedido feito). Senão, false.",
    },
  },

  required: ["resposta", "status", "resumo", "quantidade_aplicavel", "produto_generico", "pergunta_itens", "varios_itens", "itens", "classificacao_resposta_nome", "pergunta_comercial", "pedido_atendente", "acompanhamento"],

  additionalProperties: false,
} as const;

const INSTRUCOES = `
Você é a assistente virtual da Loja Exemplo, uma loja de material de construção.

Seu objetivo é coletar somente o mínimo necessário para um vendedor humano continuar o atendimento, e encaminhar o cliente o mais rápido possível.

A TRIAGEM SEGUE ESTA SEQUÊNCIA:

1. nome
2. produto/interesse
3. quantidade (somente quando fizer sentido)
4. observações

REGRAS PRINCIPAIS:

- Faça no máximo UMA pergunta por mensagem.
- Não faça várias perguntas juntas.
- Nunca pergunte novamente algo que o cliente já informou.
- Aproveite todas as informações que o cliente fornecer espontaneamente, inclusive na primeira mensagem.
- Se uma mensagem trouxer várias informações, preencha todos os campos correspondentes.
- Não invente informações.
- Não pergunte ambiente, medidas, prazo ou necessidade.
- Não calcule quantidade de materiais nem área.
- Não avalie tecnicamente uma obra.
- Se o cliente não souber alguma informação, registre "Não informado".
- Se o cliente não quiser informar alguma informação, não insista e siga para a próxima etapa.
- O nome deve ser perguntado, mas o cliente não é obrigado a informar.

VOCÊ NUNCA PODE:

- informar preço, estoque, disponibilidade ou prazo de entrega;
- recomendar produto como vendedor;
- negociar ou fornecer orçamento.

Você apenas coleta e organiza as informações para o vendedor.

MENSAGENS SEGUIDAS:
O cliente costuma mandar várias mensagens seguidas; elas chegam juntas, uma por linha. Considere todas.

NOME:
Tente descobrir o nome do cliente.
Saudação ("oi", "bom dia") e frase de pedido ("quero fazer um orçamento") não são nome.
Na etapa do nome, classificacao_resposta_nome: nome_pessoa ("Rosa", "Ferro Santos"), produto (qualquer um: "luva de pedreiro", "rejunte cinza") ou outro (saudação, pergunta, pedido sem produto).

PRODUTO/INTERESSE:
Registre o que o cliente procura do jeito que ele descreveu: produto, marca, modelo, material, uma pergunta sobre um item ou o que ele precisa resolver.
A necessidade do cliente deve ser identificada pelo que ele escreveu, sem perguntar separadamente.
Se o cliente disser só uma categoria (ex.: "materiais elétricos", "material hidráulico", "material de construção", "coisas pra obra", "várias coisas"), marque produto_generico e escreva em pergunta_itens UMA pergunta pedindo os itens, com exemplos da categoria (ex.: "Quais materiais elétricos você precisa? Por exemplo: fios, tomadas, disjuntores, lâmpadas."). O sistema faz essa pergunta uma vez só; se mesmo assim o cliente não detalhar, siga a triagem normalmente, sem insistir.
Produtos citados depois, em qualquer etapa (inclusive na resposta das observações), também vão para produto.
Intenção sem produto ("quero fazer um orçamento", "quero comprar", "quanto custa?") não é produto: deixe "Não informado" (o sistema pergunta o produto depois). Nunca use o nome do cliente como produto.

QUANTIDADE:
Opcional. Registre se o cliente informar.
Indique em quantidade_aplicavel se faz sentido perguntar a quantidade para o que o cliente procura. Só use false quando a quantidade realmente não se aplica (ex.: serviço ou dúvida).
Se houver mais de um item específico, marque varios_itens: o sistema pergunta a quantidade de todos numa pergunta só. Registre a quantidade de cada um quando informada.

ITENS:
Liste em itens TODOS os itens do pedido até agora (os já registrados e os novos), um por produto.
Características do produto (tamanho, marca, medida, ex.: "caixa d'água de 500 litros") ficam no nome do produto, nunca no lugar da quantidade.
Quantidade não informada: "".

PERGUNTAS QUE SÓ O VENDEDOR RESPONDE:
Você não sabe estoque, preço, prazo de entrega nem formas de pagamento, e nunca responde a essas perguntas: o sistema avisa o cliente que o vendedor confirma.
Marque em pergunta_comercial o tipo da pergunta da mensagem atual:
- disponibilidade: se a loja tem um produto ("vocês tem tinta branco neve?", "tem cimento?", "trabalham com porcelanato?");
- preco: preço ou valor ("quanto custa?", "qual o valor do saco?");
- prazo: entrega ou prazo ("entrega hoje?", "chega amanhã?");
- pagamento: forma de pagamento: cheque, cartão, pix, boleto, parcelamento, vales e programas de benefício ("aceita cartão?", "parcela?", "aceitam o cheque Bora Estudar?");
- outra: outra pergunta sobre a loja que só o vendedor responde ("vocês abrem domingo?");
- null: a mensagem não tem pergunta assim.
O produto citado na pergunta é registrado normalmente (em disponibilidade, "tinta branco neve" é o item).
Produto com qualificador e sem pergunta ("lajotas em promoção", "cimento mais barato", "tinta em oferta") não é pergunta: pergunta_comercial null, o item só com o produto ("lajotas") e o qualificador em observacoes ("Cliente procura lajotas em promoção."). A pergunta em si nunca é produto, item, nome nem quantidade.
Exceto em disponibilidade (o sistema registra), escreva a pergunta em observacoes, de forma curta (ex.: "Cliente quer saber se a loja aceita cheque Bora Estudar.").

OBSERVAÇÕES:
Só o que não cabe em produto ou quantidade (ex.: prazo, entrega, ambiente, forma de pagamento), sem perguntar por eles.
Nunca repita em observações um produto ou quantidade: produto novo vai para produto/quantidade. Se não sobrar nada, use "Não informado".
Intenção genérica (fazer orçamento, comprar, saber preço) não é observação.

RECLAMAÇÕES:

Não transfira automaticamente para humano apenas porque o cliente reclamou.

PEDIDO DE ATENDENTE:
Se o cliente pedir para falar com uma pessoa ("falar com atendente", "quero falar com uma pessoa", "vendedor", "humano", "alguém da loja", "não quero robô"), marque pedido_atendente: o sistema encaminha ao vendedor na hora, em qualquer etapa, mesmo sem nome. O pedido nunca é produto, item, nome nem observação (o sistema registra). Senão, pedido_atendente é false.

ACOMPANHAMENTO DE PEDIDO OU ATENDIMENTO ANTERIOR:
Marque acompanhamento quando o cliente fala de algo que já existe:
- orçamento ou pedido já feito, com ou sem número ("Orçamento 63070800", "veja no sistema de vocês esse orçamento liberado hoje");
- cobrança de retorno ("a vendedora ainda não entrou em contato", "o vendedor não me chamou", "estou aguardando", "tô esperando faz uma hora");
- conversa anterior com alguém da loja ("já falei com o Carlos", "ela mandou a mensagem aqui");
- entrega ou pagamento de um pedido existente.
O sistema encaminha ao vendedor na hora, sem pedir nome. Nada disso é produto, item, nome nem observação (o sistema registra as palavras do cliente). Um pedido novo de produto não é acompanhamento. Senão, acompanhamento é false.

ASSUNTOS DE RISCO:

Assuntos estruturais ou potencialmente perigosos devem ser encaminhados para humano.

Não forneça instruções técnicas perigosas.

QUANDO A TRIAGEM ESTIVER COMPLETA:

A sequência deve ser concluída.

O sistema decide quando o atendimento passa para HUMANO.

QUANDO HUMANO:

- não faça perguntas;
- não continue a triagem;
- não peça mais informações;
- informe que o atendimento será encaminhado para um vendedor da Loja Exemplo.

O telefone do cliente nunca deve ser preenchido pelo Claude.
Esse campo é controlado pelo sistema.
`.trim();

/*
 * Estado lido do banco para reconstruir o atendimento
 * (Passo 5d).
 */
export type EstadoRestauradoIA = {
  triagem: EstadoTriagem;

  resumo: ResumoCliente;

  historico: { papel: "user" | "assistant"; texto: string }[];

  ultimaMensagemEm: number;
};

type SaidaClaude = {
  resposta: string;

  status: string;

  resumo: Record<string, unknown>;

  quantidade_aplicavel?: boolean;

  produto_generico?: boolean;

  pergunta_itens?: string;

  varios_itens?: boolean;

  itens?: unknown;

  classificacao_resposta_nome?: unknown;

  pergunta_comercial?: unknown;

  pedido_atendente?: unknown;

  acompanhamento?: unknown;
};

/**
 * Mantém o valor anterior quando o Claude devolve
 * campo vazio ou "Não informado".
 */
function normalizarCampo(novo: unknown, anterior: string): string {
  const anteriorLimpo =
    anterior.trim() === "" ? NAO_INFORMADO : anterior.trim();

  if (typeof novo !== "string") {
    return anteriorLimpo;
  }

  const novoLimpo = novo.trim();

  if (novoLimpo === "") {
    return anteriorLimpo;
  }

  const vazio =
    novoLimpo.toLowerCase() === "não informado" ||
    novoLimpo.toLowerCase() === "nao informado";

  if (vazio && anteriorLimpo !== NAO_INFORMADO) {
    return anteriorLimpo;
  }

  if (vazio) {
    return NAO_INFORMADO;
  }

  return novoLimpo;
}

/*
 * Mesmo limite de atendimentos.nome (VARCHAR(150)).
 */
const MAX_CARACTERES_NOME = 150;

/**
 * Corta o nome em MAX_CARACTERES_NOME caracteres.
 *
 * Conta por code point (como o PostgreSQL em UTF8),
 * então um emoji nunca é partido ao meio.
 */
function limitarNome(nome: string): string {
  const caracteres = Array.from(nome);

  if (caracteres.length <= MAX_CARACTERES_NOME) {
    return nome;
  }

  return caracteres.slice(0, MAX_CARACTERES_NOME).join("").trimEnd();
}

/**
 * Normaliza textos para comparações.
 */
function normalizarTexto(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s/.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detecta pedido explícito de humano.
 */
function pediuHumanoExplicitamente(mensagem: string): boolean {
  const texto = normalizarTexto(mensagem);

  const padroes = [
    /\bquero falar com (um )?(vendedor|atendente|humano)\b/,

    /\bquero falar com alguem\b/,

    /\bme passa (um )?vendedor\b/,

    /\bme passe (um )?vendedor\b/,

    /\bpode me passar (para )?(um )?vendedor\b/,

    /\bpode me passar (para )?(um )?atendente\b/,

    /\bquero falar com alguem da loja\b/,

    /\bpode chamar (um )?vendedor\b/,

    /\bquero atendimento humano\b/,

    /\bquero um vendedor\b/,

    /\bquero um atendente\b/,

    /\b(falar|conversar) com (um |uma |o |a )?(atendente|vendedor|vendedora|humano|pessoa|alguem)\b/,

    /\b(chama|chame|chamar|passa|passe) (um |uma |o |a |pro |pra )?(atendente|vendedor|vendedora)\b/,

    /\bnao quero (falar com )?(robo|bot|maquina|ia)\b/,

    /^(atendente|vendedor|vendedora|humano|atendimento humano)$/,
  ];

  return padroes.some((padrao) => padrao.test(texto));
}

/**
 * Detecta assuntos potencialmente perigosos.
 */
function assuntoDeRisco(mensagem: string): boolean {
  const texto = normalizarTexto(mensagem);

  const padroes = [
    /\bderrubar parede\b/,
    /\bretirar parede\b/,
    /\bremover parede\b/,
    /\babrir parede\b/,
    /\bparede estrutural\b/,

    /\b(laje|viga|pilar)\b.*\b(derrubar|remover|quebrar|cortar|furar|alterar)\b/,
    /\b(derrubar|remover|quebrar|cortar|furar|alterar)\b.*\b(laje|viga|pilar)\b/,

    /\bpadrao de entrada\b/,
    /\btrifasico\b/,
    /\bquadro de distribuicao\b/,
    /\bfiacao de alta carga\b/,
    /\beletrica pesada\b/,
  ];

  return padroes.some((padrao) => padrao.test(texto));
}

/*
 * Expressões de quem não sabe ou não quer
 * informar (texto já normalizado, sem acento).
 */
const NUCLEOS_RECUSA = [
  /\bnao (sei|lembro)( (dizer|informar|responder))?\b/,
  /\bnao (faco|tenho)( a menor| nenhuma)? ideia\b/,
  /\bnem ideia\b/,
  /\bsei la\b/,
  /\bnao tenho (certeza|(essa|esta|a) informacao|informacao)\b/,
  /\b(nao quero|prefiro nao) (informar|dizer|falar|responder)\b/,
];

/*
 * Palavras que podem acompanhar a recusa
 * sem trazer informação nova.
 */
const COMPLEMENTOS_RECUSA = new Set([
  "eu", "ainda", "agora", "no", "momento", "por", "enquanto", "certo", "ao",
  "a", "o", "as", "os", "da", "do", "de", "essa", "esse", "esta", "isso",
  "quantidade", "quantidades", "nome", "produto", "material", "observacao",
  "observacoes", "informacao", "info", "exatamente", "direito", "bem",
  "mesmo", "quanto", "quantos", "quantas", "vou", "precisar", "ok", "entao",
  "infelizmente", "desculpa", "ne", "viu", "sobre",
]);

/**
 * Detecta respostas negativas.
 */
function clienteNaoSabeOuNaoQuerInformar(mensagem: string): boolean {
  const texto = normalizarTexto(mensagem);

  const respostasNegativas = [
    "nao",
    "nao sei",
    "nao tenho",
    "nao tenho ideia",
    "nao quero informar",
    "prefiro nao informar",
    "nao quero dizer",
    "nenhum",
    "nenhuma",
    "nada",
    "sem observacoes",
    "sem observacao",
    "sem observacoes adicionais",
    "nao possui",
    "nao tenho observacoes",
    "nao tenho nenhuma",
  ];

  if (respostasNegativas.some((resposta) => texto === normalizarTexto(resposta))) {
    return true;
  }

  /*
   * Variações naturais: "não sei a quantidade",
   * "não faço ideia", "não tenho essa informação"...
   *
   * Só é recusa se, tirando a expressão, sobrar
   * apenas complemento sem informação. Assim
   * "não sei a quantidade, mas quero 10 caixas"
   * NÃO é recusa.
   */
  let resto = texto;

  let encontrouRecusa = false;

  for (const padrao of NUCLEOS_RECUSA) {
    if (padrao.test(resto)) {
      encontrouRecusa = true;

      resto = resto.replace(padrao, " ");
    }
  }

  if (!encontrouRecusa) {
    return false;
  }

  return resto
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((palavra) => palavra !== "")
    .every((palavra) => COMPLEMENTOS_RECUSA.has(palavra));
}

/**
 * Detecta respostas de encerramento das observações.
 */
function semObservacoes(mensagem: string): boolean {
  const texto = normalizarTexto(mensagem);

  const respostas = [
    "nao",
    "nao tenho",
    "nao tenho nenhuma",
    "nenhuma",
    "nenhum",
    "nada",
    "sem observacoes",
    "sem observacao",
    "sem observacoes adicionais",
    "so isso",
    "e so isso",
    "isso e tudo",
  ];

  return respostas.some((resposta) => texto === normalizarTexto(resposta));
}

/*
 * Saudações e frases de pedido sem produto (texto já normalizado, sem
 * pontuação). Não servem como nome, produto nem observação.
 */
const SAUDACAO = /^(oi+|ola|opa|e ai|eai|bom dia|boa tarde|boa noite|tudo bem|tudo bom)( (tudo bem|tudo bom|boa tarde|boa noite|bom dia))?$/;

const INTENCAO_SEM_PRODUTO =
  /^((oi+|ola|opa|bom dia|boa tarde|boa noite) )?((eu )?(quero|queria|gostaria( de)?|preciso( de)?|vim|vou|posso) )?((fazer|pedir|solicitar|saber|ver|um|uma|o|a) )*(orcamento|orcamentos|cotacao|preco|precos|valor|valores|comprar|uma compra|compra)( (de|dos|das|para|pra) (materiais|material|produtos|obra))?( por favor)?$/;

const PALAVRAS_QUE_NAO_SAO_NOME =
  /\b(quero|queria|preciso|gostaria|orcamento|cotacao|comprar|preco|precos|valor|voces|vcs|qual|quais|quanto|quantos|onde|como|loja|produto|produtos|material|materiais|entrega|obra)\b/;

/*
 * Palavras de produto/material (sem acento): resposta assim na etapa do
 * nome é produto, não nome.
 */
const PALAVRAS_DE_PRODUTO =
  /\b(cimento|areia|brita|pedra|tijolos?|blocos?|telhas?|argamassa|rejunte|cal|gesso|tintas?|massa corrida|selador|verniz|textura|impermeabilizante|manta|canos?|tubos?|conexao|conexoes|joelho|registro|torneiras?|caixa d agua|caixa dagua|fios?|cabos?|tomadas?|interruptor(es)?|disjuntor(es)?|lampadas?|pisos?|porcelanato|ceramica|azulejos?|madeira|compensado|pregos?|parafusos?|ferro|vergalhao|arame|portas?|janelas?|fechadura|cadeado|ferramentas?|materiais|material|eletricos?|eletricas?|hidraulicos?|hidraulicas?)\b/;

/**
 * A mensagem é produto/material (e não saudação nem só intenção)?
 */
function pareceProduto(texto: string): boolean {
  const limpo = textoSemPontuacao(texto);

  return PALAVRAS_DE_PRODUTO.test(limpo) && !SAUDACAO.test(limpo) && !INTENCAO_SEM_PRODUTO.test(limpo);
}

/*
 * Tratamentos antes do nome ("seu João", "dona Maria").
 */
const TRATAMENTOS = new Set(["seu", "sr", "sr.", "senhor", "sra", "sra.", "senhora", "dona", "dr", "dr.", "dra", "dra.", "d."]);

/**
 * Primeiro nome para o "Certo, {nome}!", só quando o nome parece mesmo
 * nome de pessoa: só letras (com acento, hífen ou apóstrofo), até 4
 * palavras sem contar o tratamento, sem palavra de produto ou de pedido.
 * Em dúvida, null ("Certo!" sem nome).
 */
function primeiroNomeConfiavel(nome: string, permitirPalavraDeProduto = false): string | null {
  const palavras = nome.trim().split(/\s+/).filter((p) => p !== "");

  const semTratamento = palavras.filter((p, i) => !(i === 0 && TRATAMENTOS.has(p.toLowerCase())));

  if (semTratamento.length === 0 || semTratamento.length > 4) {
    return null;
  }

  if (!semTratamento.every((p) => /^\p{L}[\p{L}'’-]*$/u.test(p))) {
    return null;
  }

  const limpo = textoSemPontuacao(semTratamento.join(" "));

  if ((!permitirPalavraDeProduto && PALAVRAS_DE_PRODUTO.test(limpo)) || PALAVRAS_QUE_NAO_SAO_NOME.test(limpo) || SAUDACAO.test(limpo)) {
    return null;
  }

  const primeiro = semTratamento[0]!;

  return primeiro.charAt(0).toLocaleUpperCase("pt-BR") + primeiro.slice(1);
}

function textoSemPontuacao(texto: string): string {
  return normalizarTexto(texto).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Frase de pedido sem produto ("quero fazer um orçamento").
 */
function pareceIntencaoSemProduto(texto: string): boolean {
  const limpo = textoSemPontuacao(texto);

  return limpo === "" || SAUDACAO.test(limpo) || INTENCAO_SEM_PRODUTO.test(limpo);
}

/**
 * O nome (do Claude ou do cliente) é na verdade saudação, frase de
 * pedido ou pergunta? Então não serve como nome. A lista de palavras de
 * produto só vale como reserva (quando a Claude não classificou a
 * resposta como nome de pessoa).
 */
function naoEhNome(texto: string, permitirPalavraDeProduto = false): boolean {
  const limpo = textoSemPontuacao(texto);

  return (
    !/[a-z]/.test(limpo) ||
    texto.includes("?") ||
    SAUDACAO.test(limpo) ||
    INTENCAO_SEM_PRODUTO.test(limpo) ||
    PALAVRAS_QUE_NAO_SAO_NOME.test(limpo) ||
    (!permitirPalavraDeProduto && PALAVRAS_DE_PRODUTO.test(limpo))
  );
}

/**
 * A mensagem do cliente serve como resposta à pergunta do nome? Além do
 * naoEhNome, não serve palavra só de números ("10") nem "ok"/"sim".
 */
function pareceNome(texto: string, permitirPalavraDeProduto = false): boolean {
  const bruto = texto.trim();

  return (
    bruto !== "" &&
    !naoEhNome(bruto, permitirPalavraDeProduto) &&
    !textoSemPontuacao(bruto).split(" ").some((palavra) => /^\d+$/.test(palavra)) &&
    !mensagemSemInformacao(bruto)
  );
}

/*
 * Observação que é só a intenção de orçamento ("Cliente quer fazer um
 * orçamento."): não é observação.
 */
const OBSERVACAO_SO_INTENCAO =
  /^(o )?cliente (quer|deseja|gostaria de|solicitou|pediu|precisa( de)?|busca|procura)( (fazer|solicitar|um|uma|de))* (orcamento|orcamentos|cotacao|preco|precos|comprar|uma compra)( (de|dos|das|para|pra) (materiais|material|produtos|obra))?$/;

function observacaoSoIntencao(texto: string): boolean {
  return OBSERVACAO_SO_INTENCAO.test(textoSemPontuacao(texto)) || INTENCAO_SEM_PRODUTO.test(textoSemPontuacao(texto));
}

function mesmoTexto(a: string, b: string): boolean {
  return textoSemPontuacao(a) !== "" && textoSemPontuacao(a) === textoSemPontuacao(b);
}

/**
 * Detecta respostas que não trazem uma informação útil.
 *
 * Isso evita transformar "ok" ou "obrigada" em nome,
 * quantidade etc.
 */
export function mensagemSemInformacao(mensagem: string): boolean {
  const texto = normalizarTexto(mensagem);

  /*
   * Só emoji, pontuação ou símbolos (👍, 🙏, 😊, "..."): sem conteúdo.
   */
  if (!/[\p{L}\p{N}]/u.test(texto)) {
    return true;
  }

  const mensagens = [
    "ok",
    "okay",
    "okk",
    "certo",
    "ta certo",
    "beleza",
    "blz",
    "ta",
    "ta bom",
    "tabom",
    "ta bem",
    "entendi",
    "sim",
    "obrigado",
    "obrigada",
    "obg",
    "brigado",
    "brigada",
    "valeu",
    "vlw",
  ];

  return mensagens.includes(texto);
}

/**
 * Verifica se um campo possui informação real.
 */
function campoPreenchido(valor: string): boolean {
  return valor.trim() !== "" && valor !== NAO_INFORMADO;
}

/**
 * Cria um resumo vazio para um novo atendimento.
 */
function criarResumoVazio(telefone: string): ResumoCliente {
  return {
    nome: NAO_INFORMADO,
    telefone,

    produto: NAO_INFORMADO,

    quantidade: NAO_INFORMADO,

    observacoes: NAO_INFORMADO,
  };
}

/**
 * Pergunta fixa de cada etapa.
 */
function perguntaDaEtapa(etapa: EtapaTriagem, resumo: ResumoCliente, variosItens = false, jaPerguntada = false): string {
  switch (etapa) {
    case "nome":
      return jaPerguntada
        ? "E qual é o seu nome?"
        : "Para começarmos, qual é o seu nome?";

    case "produto":
      return jaPerguntada
        ? "Me conta qual produto ou material você precisa? Pode ser também a marca ou o modelo."
        : "Qual produto ou material você está procurando? Pode ser também a marca ou o modelo.";

    case "quantidade":
      if (variosItens) {
        return "Qual a quantidade de cada um? Se ainda não souber, sem problema.";
      }

      return campoPreenchido(resumo.produto)
        ? "Qual quantidade você precisa? Se ainda não souber, sem problema."
        : "Qual quantidade você precisa?";

    case "observacoes":
      return 'Quer acrescentar alguma observação para o vendedor? Se não, é só responder "não" que já te encaminho.';
  }
}

/*
 * Pergunta de estoque, preço ou prazo: a IA não sabe; o vendedor confirma.
 * Uma frase antes da pergunta da etapa (a triagem segue).
 */
export const AVISO_PERGUNTA_COMERCIAL =
  "Estoque, preço e prazo de entrega quem confirma é o vendedor, que vai continuar o seu atendimento.";

const PERGUNTA_COMERCIAL =
  /(\btem\b[^.!\n]*\?|\b(voces|vcs|vc|voce) (tem|trabalham com|vendem)\b|\bquanto (custa|sai|fica|e|ta|esta)\b|\bqual (o |e o )?(preco|valor)\b|\bsaber o (preco|valor)\b|\b(preco|valor)\b[^.!\n]*\?|\bentrega(m)? (hoje|amanha|quando)\b|\bprazo de entrega\b|\bem estoque\b|\bdisponibilidade\b|\btem disponivel\b)/;

/**
 * O cliente perguntou de estoque, preço ou prazo?
 */
function perguntaComercial(mensagem: string): boolean {
  const texto = mensagem.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  return PERGUNTA_COMERCIAL.test(texto);
}

/*
 * Pergunta sobre forma de pagamento (cheque, cartão, pix, boleto,
 * parcelamento, vales e programas de benefício): reserva do texto.
 */
const PERGUNTA_PAGAMENTO =
  /\b(cheques?|cartao|cartoes|credito|debito|pix|boletos?|parcel\w*|(em|quantas) (\d+ )?vezes|vales?[ -](alimentacao|refeicao|compras?|gas)|crediario|bora estudar|formas? de pagamento|pagamento|pagar)\b/;

/**
 * Pergunta que só o vendedor responde. "geral" = achada só pelo texto
 * (reserva), sem saber o tipo: aviso genérico e a triagem segue.
 */
export type TipoPerguntaComercial = "disponibilidade" | "preco" | "prazo" | "pagamento" | "outra" | "geral";

/*
 * Aviso de cada tipo: uma frase antes da pergunta da etapa.
 */
export const AVISOS_PERGUNTA_COMERCIAL: Record<TipoPerguntaComercial, string> = {
  disponibilidade: "Quem confirma o estoque é o vendedor, que vai continuar o seu atendimento.",
  preco: "O preço quem confirma é o vendedor, que vai continuar o seu atendimento.",
  prazo: "O prazo de entrega quem confirma é o vendedor, que vai continuar o seu atendimento.",
  pagamento: "Formas de pagamento quem confirma é o vendedor, que vai continuar o seu atendimento.",
  outra: "Essa informação quem confirma é o vendedor, que vai continuar o seu atendimento.",
  geral: AVISO_PERGUNTA_COMERCIAL,
};

function textoSemAcento(mensagem: string): string {
  return mensagem.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

/**
 * Tipo da pergunta comercial: o da Claude (pergunta_comercial); null
 * da Claude = nenhuma. Ausente ou fora dos valores: reserva pelo texto
 * (pagamento com "?" ou "aceita"; senão o aviso genérico).
 */
function lerPerguntaComercial(saida: SaidaClaude, mensagem: string): TipoPerguntaComercial | null {
  const valor = saida.pergunta_comercial;

  if (valor === "disponibilidade" || valor === "preco" || valor === "prazo" || valor === "pagamento" || valor === "outra") {
    return valor;
  }

  if (valor === null) {
    return null;
  }

  const texto = textoSemAcento(mensagem);

  if (PERGUNTA_PAGAMENTO.test(texto) && /\?|\baceita(m)?\b/.test(texto)) {
    return "pagamento";
  }

  return perguntaComercial(mensagem) ? "geral" : null;
}

/**
 * O "produto" é na verdade a pergunta do cliente? (Pergunta nunca vira
 * item.)
 */
function produtoEhPergunta(produto: string, mensagem: string, tipo: TipoPerguntaComercial): boolean {
  return (
    produto.includes("?") ||
    (mesmoTexto(produto, mensagem) && pareceFrasePergunta(mensagem)) ||
    (tipo === "pagamento" && PERGUNTA_PAGAMENTO.test(textoSemAcento(produto)))
  );
}

/*
 * Começo típico de pergunta (sem "?"): "vocês tem...", "aceita...",
 * "quanto...", "gostaria de saber...".
 */
const INICIO_DE_PERGUNTA =
  /^((oi|ola|bom dia|boa tarde|boa noite)[ ,!.]*)?(voces|vcs|vc|voce|tem|teria|aceita\w*|qual|quais|quanto\w*|quando|como|onde|gostaria de saber|queria saber|quero saber|pode\w*|posso|faz|fazem|entrega\w*|abre\w*|parcela\w*|da pra|tem como)\b/;

/**
 * A mensagem é uma pergunta (tem "?" ou começa como pergunta)?
 */
function pareceFrasePergunta(mensagem: string): boolean {
  const texto = textoSemAcento(mensagem).replace(/[^\p{L}\p{N}\s?]/gu, " ").replace(/[ \t]+/g, " ").trim();

  return texto.includes("?") || texto.split("\n").some((linha) => INICIO_DE_PERGUNTA.test(linha.trim()));
}

/*
 * Qualificador comercial junto do produto ("lajotas em promoção",
 * "cimento mais barato", "tinta em oferta", "preço bom"): o produto vira
 * item e o qualificador vai para as observações; não é pergunta.
 */
const QUALIFICADOR_COMERCIAL =
  /\s*\b(em promocao|na promocao|de promocao|em oferta|na oferta|de oferta|mais barat[oa]s?|bem barat[oa]s?|barat[oa]s?|em liquidacao|com desconto|(com |de |a |no )?preco bom|(com |de |a |no )?bom preco)\b/;

function semAcentoMantendoTamanho(texto: string): string {
  return [...texto].map((c) => c.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "") || c).join("");
}

/**
 * Tira o qualificador comercial do nome do produto ("Lajotas em promoção"
 * → "Lajotas"); null se não tinha.
 */
function produtoSemQualificador(produto: string): string | null {
  const base = semAcentoMantendoTamanho(produto);

  const achado = QUALIFICADOR_COMERCIAL.exec(base);

  if (!achado) {
    return null;
  }

  const limpo = `${produto.slice(0, achado.index)} ${produto.slice(achado.index + achado[0].length)}`.replace(/\s+/g, " ").trim();

  return limpo === "" ? null : limpo;
}

/**
 * Junta uma frase às observações (sem duplicar).
 */
function juntarObservacao(observacoes: string, frase: string): string {
  if (!campoPreenchido(observacoes) || observacoes === "Nenhuma observação adicional.") {
    return frase;
  }

  return observacoes.includes(frase) ? observacoes : `${observacoes} ${frase}`;
}

/**
 * Observações: frases iguais saem; "Cliente quer saber se tem X." e
 * "Cliente quer saber marca e valor de X." viram uma só: "Cliente quer
 * saber se tem X, marca e valor.".
 */
export function unirNotasRepetidas(observacoes: string): string {
  const frases = observacoes.split(/(?<=\.)\s+/).map((frase) => frase.trim()).filter((frase) => frase !== "");

  const mesmoProduto = (a: string, b: string) => {
    const ca = chaveItem(a);

    const cb = chaveItem(b);

    return ca !== "" && cb !== "" && (ca.includes(cb) || cb.includes(ca));
  };

  for (let i = 0; i < frases.length; i++) {
    const tem = /^Cliente quer saber se tem (.+?)\.?$/.exec(frases[i] ?? "");

    if (!tem?.[1]) {
      continue;
    }

    const produto = tem[1];

    const extras: string[] = [];

    for (let j = 0; j < frases.length; j++) {
      if (j === i || !frases[j]) {
        continue;
      }

      const outra = /^Cliente quer saber (?!se tem )(.+?) (?:de|do|da|dos|das|sobre) (.+?)\.?$/.exec(frases[j]!);

      if (outra?.[1] && outra[2] && mesmoProduto(outra[2], produto)) {
        extras.push(outra[1]);

        frases[j] = "";
      }
    }

    if (extras.length > 0) {
      frases[i] = `Cliente quer saber se tem ${produto}, ${extras.join(", ")}.`;
    }
  }

  const vistas = new Set<string>();

  return frases
    .filter((frase) => {
      const chave = textoSemPontuacao(frase);

      if (frase === "" || vistas.has(chave)) {
        return false;
      }

      vistas.add(chave);

      return true;
    })
    .join(" ");
}

/*
 * Começo da observação de quem perguntou se a loja tem o produto (na
 * recuperação, marca que o atendimento vai direto ao vendedor).
 */
const OBSERVACAO_DISPONIBILIDADE = "Cliente quer saber se tem ";

/*
 * Observação de quem pediu para falar com uma pessoa.
 */
export const OBSERVACAO_PEDIU_ATENDENTE = "Cliente pediu para falar com um atendente.";

/*
 * Resposta ao pedido de atendente (sem o "Perfeito!").
 */
export const RESPOSTA_PEDIDO_ATENDENTE = "Certo! Vou passar seu atendimento para um vendedor da loja.";

const LIMITE_CITACAO_PEDIDO = 200;

/**
 * Observação do pedido de atendente com as palavras do cliente, entre
 * aspas, sem interpretar nem corrigir (a equipe sabe de quem ele fala).
 * Do lote, só as linhas com o pedido (nenhuma reconhecida pelo texto:
 * todas). Até LIMITE_CITACAO_PEDIDO caracteres, cortado com "…".
 */
export function observacaoPedidoAtendente(mensagem: string): string {
  const citacao = citarCliente(mensagem, pediuHumanoExplicitamente);

  return citacao === "" ? OBSERVACAO_PEDIU_ATENDENTE : `Cliente pediu para falar com um atendente: "${citacao}".`;
}

/**
 * As palavras do cliente para a observação: do lote, só as linhas que o
 * detector reconhece (nenhuma: todas), até LIMITE_CITACAO_PEDIDO
 * caracteres, cortado com "…". Sem interpretar nem corrigir.
 */
function citarCliente(mensagem: string, detector: (linha: string) => boolean): string {
  const linhas = mensagem.split("\n").map((linha) => linha.replace(/\s+/g, " ").trim()).filter((linha) => linha !== "");

  const reconhecidas = linhas.filter((linha) => detector(linha));

  const citacao = (reconhecidas.length > 0 ? reconhecidas : linhas).join(" ");

  return [...citacao].length > LIMITE_CITACAO_PEDIDO ? `${[...citacao].slice(0, LIMITE_CITACAO_PEDIDO - 1).join("").trimEnd()}…` : citacao;
}

/*
 * Acompanhamento de pedido, orçamento ou atendimento que já existe:
 * reserva pelo texto (a Claude decide, pelo campo acompanhamento).
 */
const ACOMPANHAMENTO = [
  /\b(orcamento|pedido)\s*(n[o.]?\s*|numero\s*|#\s*)?\d{4,}/,
  /\b(esse|este|meu|o|do|desse|deste) (orcamento|pedido)\b.*\b(liberad\w*|aprovad\w*|feito|fechad\w*|pag\w*|entreg\w*)/,
  /\b(ainda )?nao (me )?(chamou|ligou|respondeu|retornou|entrou em contato|entraram em contato|mandou mensagem)\b/,
  /\b(estou|to|tou|fico|ficou|continuo) (esperando|aguardando)\b/,
  /\besperando (faz|ha|a) /,
  /\bja falei com\b/,
  /\b(meu|o meu) pedido\b/,
  /\bsistema de voces\b/,
];

export function pareceAcompanhamento(mensagem: string): boolean {
  const texto = normalizarTexto(mensagem);

  return ACOMPANHAMENTO.some((padrao) => padrao.test(texto));
}

/**
 * Observação do acompanhamento, com as palavras do cliente.
 */
export function observacaoAcompanhamento(mensagem: string): string {
  const citacao = citarCliente(mensagem, pareceAcompanhamento);

  return citacao === "" ? "Cliente falou de um pedido ou atendimento anterior." : `Cliente falou de um pedido ou atendimento anterior: "${citacao}".`;
}

/*
 * Resposta sem conteúdo ("ok", "certo") e a mesma etapa de novo: uma
 * variação curta, nunca a pergunta idêntica.
 */
const VARIACAO_DA_ETAPA: Record<EtapaTriagem, string> = {
  nome: "E qual é o seu nome?",
  produto: "E qual produto ou material você precisa?",
  quantidade: "E a quantidade, você já sabe? Se não souber, sem problema.",
  observacoes: 'Pode me dizer a observação? Se não tiver, é só responder "não".',
};

/*
 * Nome de cada etapa no aviso "Cliente parou de responder".
 */
export const NOME_DA_ETAPA: Record<EtapaTriagem, string> = {
  nome: "nome",
  produto: "produto",
  quantidade: "quantidade",
  observacoes: "observações",
};

/**
 * Itens do Claude (lista de {produto, quantidade}). Quantidade vazia,
 * "Não informado" ou "a confirmar" = não informada.
 */
function lerItensDoClaude(valor: unknown): ItemPedido[] {
  if (!Array.isArray(valor)) {
    return [];
  }

  const itens: ItemPedido[] = [];

  for (const bruto of valor) {
    const produto = typeof bruto?.produto === "string" ? bruto.produto.replace(/\s+/g, " ").trim() : "";

    const quantidade = typeof bruto?.quantidade === "string" ? bruto.quantidade.replace(/\s+/g, " ").trim() : "";

    if (produto === "" || produto === NAO_INFORMADO) {
      continue;
    }

    const semQuantidade = quantidade === "" || /^(nao informado|a confirmar|nao sei)$/i.test(quantidade.normalize("NFD").replace(/[\u0300-\u036f]/g, ""));

    itens.push({ produto, quantidade: semQuantidade ? null : quantidade });
  }

  return itens;
}

const chaveItem = (produto: string) => textoSemPontuacao(produto);

type ClassificacaoNome = "nome_pessoa" | "produto" | "outro";

/**
 * Classificação da Claude para a resposta na etapa do nome; ausente ou
 * inválida = null (vale a lista de reserva).
 */
function lerClassificacaoNome(valor: unknown): ClassificacaoNome | null {
  return valor === "nome_pessoa" || valor === "produto" || valor === "outro" ? valor : null;
}

/*
 * Pergunta pelos itens quando o produto é só uma categoria: a que o
 * Claude escreveu, se for UMA pergunta curta numa linha; senão, a fixa.
 */
const PERGUNTA_ITENS_PADRAO = "Quais itens você precisa? Pode listar os produtos.";

function perguntaDosItens(sugerida: unknown): string {
  const texto = typeof sugerida === "string" ? sugerida.trim() : "";

  const valida =
    texto.length >= 10 &&
    texto.length <= 220 &&
    !/[\r\n]/.test(texto) &&
    (texto.match(/\?/g) ?? []).length === 1;

  return valida ? texto : PERGUNTA_ITENS_PADRAO;
}

/**
 * Marca etapas já preenchidas.
 */
function marcarEtapasPreenchidas(
  resumo: ResumoCliente,
  etapasConcluidas: Set<EtapaTriagem>,
): void {
  if (campoPreenchido(resumo.nome)) {
    etapasConcluidas.add("nome");
  }

  if (campoPreenchido(resumo.produto)) {
    etapasConcluidas.add("produto");
  }

  if (campoPreenchido(resumo.quantidade)) {
    etapasConcluidas.add("quantidade");
  }

  if (campoPreenchido(resumo.observacoes)) {
    etapasConcluidas.add("observacoes");
  }
}

/**
 * Encontra a próxima etapa.
 */
function encontrarProximaEtapa(
  etapasConcluidas: Set<EtapaTriagem>,
): EtapaTriagem | null {
  for (const etapa of ORDEM_ETAPAS) {
    if (!etapasConcluidas.has(etapa)) {
      return etapa;
    }
  }

  return null;
}

/**
 * Tenta aproveitar diretamente a resposta do cliente
 * para a etapa que estava sendo perguntada.
 *
 * Exemplo:
 *
 * etapa = quantidade
 * mensagem = "10 sacos"
 *
 * resultado:
 * quantidade = "10 sacos"
 *
 * Isso impede que a pergunta seja repetida
 * apenas porque o Claude não interpretou sozinho
 * uma resposta curta.
 */
function extrairRespostaDireta(
  etapa: EtapaTriagem,
  mensagem: string,
): string | null {
  const texto = mensagem.trim();

  if (texto === "") {
    return null;
  }

  if (clienteNaoSabeOuNaoQuerInformar(mensagem)) {
    return null;
  }

  if (mensagemSemInformacao(mensagem)) {
    return null;
  }

  switch (etapa) {
    case "nome":
      return pareceNome(texto) ? texto : null;

    case "produto":
      return pareceIntencaoSemProduto(texto) ? null : texto;

    case "quantidade": {
      const pareceQuantidade =
        /\b\d+(?:[,.]\d+)?\s*(?:unidades?|unid|pecas?|peças?|gal(?:oes|ões)?|l|litros?|kg|g|sacos?|sacolas?|caixas?|metros?|m)\b/i.test(
          texto,
        );

      return pareceQuantidade ? texto : null;
    }

    case "observacoes":
      return texto;
  }
}

/**
 * Mensagem enviada quando o atendimento vai para humano.
 */
function gerarRespostaHumano(): string {
  return "Perfeito! Vou encaminhar seu atendimento para um vendedor da loja, que dará continuidade.";
}

/**
 * Encaminhamento automático (o cliente parou de responder): sem o
 * "Perfeito!", que soaria estranho. Nas observações, "seu pedido"; nas
 * outras etapas, "sua mensagem". Loja fechada: o vendedor chama no
 * próximo horário.
 */
export type MotivoEncaminhamentoAutomatico = "observacoes" | "parou" | "midia";

export function textoEncaminhamentoAutomatico(semObservacoes: boolean, aberta: boolean): string {
  const final = aberta ? "que vai continuar o seu atendimento." : "que vai te chamar no próximo horário de atendimento.";

  return `Vou passar ${semObservacoes ? "seu pedido" : "sua mensagem"} para um vendedor da loja, ${final}`;
}

/**
 * Apresentação de início de atendimento.
 *
 * Não colocamos pergunta aqui para que o sistema
 * possa fazer exatamente UMA pergunta depois.
 */
const MENSAGEM_INICIAL =
  "Olá! Seja bem-vindo(a) à loja Exemplo Materiais de Construção! Sou a assistente virtual e vou dar início ao seu atendimento.";

/*
 * Avisos de mídia (B7): a IA não vê imagens nem ouve áudios.
 *
 * - INICIO: atendimento começando (vai depois da apresentação);
 * - SEM_LEGENDA / COM_LEGENDA: já houve apresentação.
 */
export const AVISO_MIDIA_INICIO =
  "Ainda não consigo ver imagens nem ouvir áudios. Pode me escrever por texto o que você procura? Ou, se preferir, posso te passar para um vendedor.";

export const AVISO_MIDIA_SEM_LEGENDA =
  "Ainda não consigo ouvir áudios nem ver imagens. Pode me escrever por texto? Ou, se preferir, posso te passar para um vendedor.";

export const AVISO_MIDIA_COM_LEGENDA =
  "Recebi sua mensagem, mas ainda não consigo ver imagens. Pode me dizer por escrito qual é o produto? Ou, se preferir, posso te passar para um vendedor.";

/*
 * Respostas afirmativas curtas ao "posso te passar para um vendedor"
 * do aviso de mídia. Só valem como a mensagem INTEIRA (sem maiúsculas,
 * acentos e pontuação) e só na 1ª mensagem de texto depois do aviso.
 * "ok", "blz", "certo", "tá", "entendi" ficam de fora de propósito (o
 * cliente pode só estar dizendo que vai escrever).
 */
const RESPOSTAS_AFIRMATIVAS_AVISO_MIDIA = new Set([
  "sim",
  "s",
  "ss",
  "pode",
  "pode sim",
  "pode passar",
  "quero",
  "claro",
  "por favor",
  "vendedor",
  "pode ser",
]);

function aceitouVendedorDoAvisoMidia(mensagem: string): boolean {
  const texto = mensagem
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return RESPOSTAS_AFIRMATIVAS_AVISO_MIDIA.has(texto);
}

/*
 * Observação do resumo quando a mídia leva o atendimento para HUMANO.
 */
const OBSERVACAO_MIDIA = "Cliente enviou áudio/imagem.";

/*
 * Mídias que chegam até 30 s depois da que gerou o aviso são o mesmo
 * envio (ex.: álbum de fotos, que a Meta manda uma por requisição).
 */
const JANELA_MESMO_ENVIO_MS = 30_000;

const ROTULOS_MIDIA: Record<TipoMidia, string> = {
  audio: "áudio",
  image: "imagem",
  video: "vídeo",
  document: "documento",
  sticker: "figurinha",
  location: "localização",
  contacts: "contato",
};

const MARCADOR_LEGENDA = /^\[enviou (.+?) com a legenda\]: ([\s\S]*)$/;

/**
 * Como a mídia entra no histórico (memória e espelho no banco):
 * "[enviou imagem com a legenda]: <texto>" ou "[enviou áudio]".
 */
export function textoDaMidia(midia: MidiaRecebida): string {
  const rotulo = ROTULOS_MIDIA[midia.tipo];

  return midia.legenda ? `[enviou ${rotulo} com a legenda]: ${midia.legenda}` : `[enviou ${rotulo}]`;
}

function anexarObservacao(observacoes: string, nota: string): string {
  if (observacoes === NAO_INFORMADO) {
    return nota;
  }

  return observacoes.includes(nota) ? observacoes : `${observacoes} ${nota}`;
}

export class IAClaude implements IA {
  /**
   * Histórico completo.
   *
   * Ele nunca é apagado por causa da inatividade.
   */
  private readonly historico: Anthropic.MessageParam[] = [];

  /**
   * Posição dentro do histórico onde começou
   * o atendimento atual.
   *
   * Assim o histórico antigo continua armazenado,
   * mas não interfere na nova triagem.
   */
  private indiceInicioAtendimento = 0;

  /**
   * Estado da triagem atual.
   */
  private readonly etapasConcluidas = new Set<EtapaTriagem>();

  /**
   * Pergunta que o sistema está aguardando.
   */
  private etapaAtual: EtapaTriagem | null = null;

  /**
   * Quantas vezes cada etapa já foi perguntada
   * no atendimento atual.
   */
  private readonly perguntasPorEtapa = new Map<EtapaTriagem, number>();

  /**
   * Indica se já existe um atendimento ativo.
   */
  private atendimentoIniciado = false;

  /**
   * Último momento em que houve mensagem.
   */
  private ultimaMensagemEm = 0;

  /**
   * Resumo pertencente ao atendimento atual.
   *
   * O resumo antigo não é reaproveitado
   * quando começa um novo atendimento.
   */
  private resumoAtual: ResumoCliente | null = null;

  /**
   * A apresentação ainda precisa chegar ao cliente?
   *
   * Volta a true se a resposta que a continha
   * não pôde ser enviada.
   */
  private apresentacaoPendente = false;

  /**
   * A quantidade foi dispensada por não fazer sentido
   * para o pedido? Só informativo (espelho no banco).
   */
  private quantidadeNaoAplicavel = false;

  /**
   * A pergunta pelos itens (produto só como categoria) já foi feita
   * neste atendimento? Uma vez só; depois a triagem segue.
   */
  private perguntouItens = false;

  /**
   * O cliente perguntou se a loja tem o produto: com o nome (ou sem
   * ele, depois das tentativas), vai direto ao vendedor, sem quantidade
   * nem observações.
   */
  private perguntouDisponibilidade = false;

  /**
   * O pedido tem mais de um item específico (segundo o Claude, na última
   * chamada): a pergunta da quantidade pede a de cada um.
   */
  private variosItens = false;

  /**
   * Itens que já existiam quando a etapa da quantidade foi concluída
   * (null = ainda não concluída). Item novo depois disso, sem
   * quantidade, recebe UMA pergunta só dele.
   */
  private itensNaQuantidade: Set<string> | null = null;

  /**
   * Itens novos cuja quantidade já foi perguntada (uma vez só).
   */
  private readonly quantidadePerguntadaDe = new Set<string>();

  /**
   * O que a última resposta registrou como entregue.
   *
   * Usado somente para desfazer quando o envio falha.
   */
  private ultimoTurno: {
    indiceResposta: number;
    incluiuApresentacao: boolean;
    etapaPerguntada: EtapaTriagem | null;

    /*
     * Resposta a uma mídia: desfazer não mexe na etapa.
     */
    midia: boolean;
  } | null = null;

  /**
   * Chegada da mídia que gerou o aviso de mídia neste atendimento.
   * null = aviso ainda não dado; 0 = dado antes de um reinício.
   */
  private avisoMidiaEm: number | null = null;

  /**
   * Mídias recebidas neste atendimento (rótulos) e se o cliente já
   * mandou algum texto: só mídia e nenhum texto = "mídia sem texto".
   */
  private readonly midiasRecebidas: string[] = [];

  private recebeuTexto = false;

  /**
   * O último aviso de mídia ainda espera a 1ª mensagem de texto
   * (que pode ser um "sim" ao oferecimento do vendedor).
   */
  private aguardandoRespostaAvisoMidia = false;

  /**
   * Legendas de mídia deste atendimento (vão para as observações
   * quando o atendimento passa para HUMANO).
   */
  private readonly legendas: { rotulo: string; legenda: string }[] = [];

  /**
   * ID interno do atendimento (ATD-...),
   * usado somente na medição de tokens.
   */
  private readonly atendimentoId: string;

  constructor(atendimentoId: string) {
    this.atendimentoId = atendimentoId;
  }

  /**
   * Permite que o webhook saiba se esse atendimento
   * ficou inativo por 20 minutos.
   */
  public estaInativa(agora = Date.now()): boolean {
    if (!this.atendimentoIniciado) {
      return false;
    }

    if (this.ultimaMensagemEm === 0) {
      return false;
    }

    return agora - this.ultimaMensagemEm >= INATIVIDADE_MS;
  }

  /**
   * Inicia um novo atendimento.
   *
   * O histórico antigo continua guardado.
   */
  private iniciarNovoAtendimento(cliente: Cliente): void {
    this.atendimentoIniciado = true;

    this.indiceInicioAtendimento = this.historico.length;

    this.etapasConcluidas.clear();

    this.perguntasPorEtapa.clear();

    this.etapaAtual = null;

    this.resumoAtual = criarResumoVazio(cliente.telefone);

    this.apresentacaoPendente = true;

    this.quantidadeNaoAplicavel = false;

    this.perguntouItens = false;

    this.perguntouDisponibilidade = false;

    this.variosItens = false;

    this.itensNaQuantidade = null;

    this.quantidadePerguntadaDe.clear();

    this.avisoMidiaEm = null;

    this.aguardandoRespostaAvisoMidia = false;

    this.legendas.length = 0;

    this.midiasRecebidas.length = 0;

    this.recebeuTexto = false;
  }

  /**
   * Reconstrói o atendimento atual a partir do banco
   * (recuperação na partida, Passo 5d).
   *
   * Etapas concluídas = campos preenchidos + etapas puladas.
   * As perguntas gravadas são da primeira etapa não concluída.
   * ultimoTurno não volta: só serve para desfazer a resposta
   * do turno corrente, e todo turno novo o zera.
   */
  restaurar(estado: EstadoRestauradoIA): void {
    this.atendimentoIniciado = true;

    this.historico.length = 0;

    this.avisoMidiaEm = null;

    this.aguardandoRespostaAvisoMidia = false;

    this.legendas.length = 0;

    this.midiasRecebidas.length = 0;

    this.recebeuTexto = false;

    for (const item of estado.historico) {
      this.historico.push({ role: item.papel, content: item.texto });

      /*
       * Aviso de mídia e legendas voltam pelo histórico (o aviso
       * conta como dado há muito tempo: fora da janela).
       */
      if (item.papel === "assistant" && [AVISO_MIDIA_INICIO, AVISO_MIDIA_SEM_LEGENDA, AVISO_MIDIA_COM_LEGENDA].some((t) => item.texto.includes(t))) {
        this.avisoMidiaEm = 0;
      }

      if (item.papel === "assistant") {
        this.aguardandoRespostaAvisoMidia = this.avisoMidiaEm === 0 && [AVISO_MIDIA_INICIO, AVISO_MIDIA_SEM_LEGENDA, AVISO_MIDIA_COM_LEGENDA].some((t) => item.texto.includes(t));
      } else if (!item.texto.startsWith("[enviou ")) {
        this.aguardandoRespostaAvisoMidia = false;
      }

      const legenda = item.papel === "user" ? MARCADOR_LEGENDA.exec(item.texto) : null;

      if (legenda?.[1] && legenda[2]) {
        this.legendas.push({ rotulo: legenda[1], legenda: legenda[2] });
      }
    }

    this.indiceInicioAtendimento = 0;

    /*
     * Mídia sem texto: volta pelo histórico ("[enviou imagem]" sem
     * nenhuma mensagem de texto do cliente).
     */
    for (const item of estado.historico) {
      if (item.papel !== "user") {
        continue;
      }

      const midia = /^\[enviou (.+?)( com a legenda)?\]/.exec(item.texto);

      if (midia?.[1]) {
        this.midiasRecebidas.push(midia[1]);
      } else {
        this.recebeuTexto = true;
      }
    }

    const resumo: ResumoCliente = { ...estado.resumo };

    this.resumoAtual = resumo;

    this.etapasConcluidas.clear();

    for (const etapa of estado.triagem.etapasPuladas) {
      this.etapasConcluidas.add(etapa);
    }

    marcarEtapasPreenchidas(resumo, this.etapasConcluidas);

    this.etapaAtual = estado.triagem.etapaAtual;

    this.perguntasPorEtapa.clear();

    const proxima = encontrarProximaEtapa(this.etapasConcluidas);

    if (proxima && estado.triagem.perguntasEtapa > 0) {
      this.perguntasPorEtapa.set(proxima, estado.triagem.perguntasEtapa);
    }

    this.apresentacaoPendente = estado.triagem.apresentacaoPendente;

    this.quantidadeNaoAplicavel = estado.triagem.quantidadeNaoAplicavel;

    /*
     * Etapa "produto" com o produto já preenchido: era a pergunta pelos
     * itens (não repete depois do reinício).
     */
    this.perguntouItens = estado.triagem.etapaAtual === "produto" && campoPreenchido(resumo.produto);

    /*
     * Pergunta de disponibilidade: volta pela observação gravada.
     */
    this.perguntouDisponibilidade = resumo.observacoes.includes(OBSERVACAO_DISPONIBILIDADE);

    this.variosItens = false;

    /*
     * Quantidade já concluída: os itens de agora contam como conhecidos
     * (não pergunta de novo a quantidade deles depois do reinício).
     */
    this.itensNaQuantidade = this.etapasConcluidas.has("quantidade")
      ? new Set(itensDoResumo(resumo.produto, resumo.quantidade).map((item) => chaveItem(item.produto)))
      : null;

    this.quantidadePerguntadaDe.clear();

    this.ultimaMensagemEm = estado.ultimaMensagemEm;

    this.ultimoTurno = null;
  }

  /**
   * Cópia do estado da triagem, no formato das
   * colunas de atendimentos (espelho no banco).
   *
   * Concluídas = campos preenchidos + etapas puladas.
   * Só a primeira etapa não concluída pode ter perguntas
   * feitas (as etapas são perguntadas em ordem).
   */
  estadoTriagem(): EstadoTriagem {
    const resumo = this.resumoAtual;

    const etapasPuladas = ORDEM_ETAPAS.filter(
      (etapa) =>
        this.etapasConcluidas.has(etapa) &&
        !(resumo && campoPreenchido(resumo[etapa])),
    );

    const proxima = encontrarProximaEtapa(this.etapasConcluidas);

    return {
      etapaAtual: this.etapaAtual,

      perguntasEtapa: proxima ? (this.perguntasPorEtapa.get(proxima) ?? 0) : 0,

      etapasPuladas,

      apresentacaoPendente: this.apresentacaoPendente,

      quantidadeNaoAplicavel: this.quantidadeNaoAplicavel,
    };
  }

  /**
   * O cliente mandou mídia (com ou sem legenda), recebeu o aviso que pede
   * o texto e não escreveu depois: os rótulos ("imagem", ...). Senão, null.
   */
  midiaSemContinuacao(): string[] | null {
    return this.aguardandoRespostaAvisoMidia && this.midiasRecebidas.length > 0 ? [...new Set(this.midiasRecebidas)] : null;
  }

  /**
   * Etapa cuja pergunta espera resposta (null = nenhuma; antes da 1ª
   * pergunta ou depois de uma resposta não entregue: a próxima etapa).
   */
  etapaAguardandoResposta(): EtapaTriagem | null {
    return this.etapaAtual ?? encontrarProximaEtapa(this.etapasConcluidas);
  }

  /**
   * O cliente parou de responder: a triagem termina com o que já tem
   * e o atendimento vai para o vendedor (sem chamar a Claude).
   */
  encaminharPorInatividade(motivo: MotivoEncaminhamentoAutomatico, aberta: boolean): ResultadoIA {
    const resumo: ResumoCliente = { ...(this.resumoAtual ?? criarResumoVazio("")) };

    if (motivo === "midia") {
      const midias = [...new Set(this.midiasRecebidas)];

      /*
       * Sem produto: o item é o da mídia ("produto da imagem enviada").
       */
      const item = midias.includes("imagem")
        ? "produto da imagem enviada"
        : midias.includes("vídeo")
          ? "produto do vídeo enviado"
          : midias.includes("documento")
            ? "produto do documento enviado"
            : null;

      if (item && !campoPreenchido(resumo.produto)) {
        resumo.produto = item;
      }

      /*
       * A legenda vai às observações (pergunta: "perguntando: ..."); sem
       * nenhuma legenda, "sem texto".
       */
      if (this.legendas.length === 0) {
        resumo.observacoes = juntarObservacao(resumo.observacoes, `Cliente enviou ${listarEmTexto(midias)} sem texto.`);
      }

      for (const { rotulo, legenda } of this.legendas) {
        const pergunta = pareceFrasePergunta(legenda) || lerPerguntaComercial({} as SaidaClaude, legenda) !== null;

        resumo.observacoes = juntarObservacao(
          resumo.observacoes,
          pergunta ? `Cliente enviou ${rotulo} perguntando: ${legenda.replace(/\s+/g, " ").trim()}` : `Cliente enviou ${rotulo} com a legenda: "${legenda}".`,
        );
      }

      resumo.observacoes = unirNotasRepetidas(resumo.observacoes);
    } else {
      resumo.observacoes = this.anexarLegendas(resumo.observacoes);
    }

    this.resumoAtual = resumo;

    this.etapaAtual = null;

    this.ultimoTurno = null;

    const texto = textoEncaminhamentoAutomatico(motivo === "observacoes", aberta);

    const resposta = this.apresentacaoPendente ? `${MENSAGEM_INICIAL}\n\n${texto}` : texto;

    this.apresentacaoPendente = false;

    return { resposta, status: "HUMANO", resumo };
  }

  /**
   * Chamado quando houve tentativa REAL de envio
   * da última resposta e ela falhou.
   *
   * Desfaz somente o que supõe que o cliente
   * recebeu a resposta:
   *
   * - a resposta do assistente sai do histórico
   *   (a mensagem do cliente continua);
   * - nenhuma pergunta fica aguardando resposta;
   * - a apresentação volta a ficar pendente,
   *   se fazia parte da resposta.
   *
   * O resumo e as etapas concluídas são mantidos:
   * vieram do que o cliente realmente informou.
   */
  desfazerRespostaNaoEntregue(): void {
    const turno = this.ultimoTurno;

    if (!turno) {
      return;
    }

    this.ultimoTurno = null;

    const ultima = this.historico[turno.indiceResposta];

    if (
      turno.indiceResposta === this.historico.length - 1 &&
      ultima?.role === "assistant"
    ) {
      this.historico.pop();
    }

    /*
     * Resposta a mídia: a etapa não tinha mudado; o aviso
     * volta a não ter sido dado.
     */
    if (turno.midia) {
      this.avisoMidiaEm = null;

      this.aguardandoRespostaAvisoMidia = false;
    } else {
      this.etapaAtual = null;
    }

    /*
     * A pergunta não chegou ao cliente:
     * não conta como tentativa.
     */
    if (turno.etapaPerguntada) {
      const feitas = this.perguntasPorEtapa.get(turno.etapaPerguntada) ?? 0;

      this.perguntasPorEtapa.set(turno.etapaPerguntada, Math.max(0, feitas - 1));
    }

    if (turno.incluiuApresentacao) {
      this.apresentacaoPendente = true;
    }
  }

  async responder(mensagem: string, cliente: Cliente): Promise<ResultadoIA> {
    const agora = Date.now();

    /*
     * Um novo turno começa: o anterior
     * não pode mais ser desfeito.
     */
    this.ultimoTurno = null;

    const novoAtendimento =
      !this.atendimentoIniciado || this.estaInativa(agora);

    /*
     * Começo de atendimento novo:
     *
     * - mantém histórico antigo;
     * - começa nova triagem;
     * - cria novo resumo;
     * - apresentação será enviada.
     */
    if (novoAtendimento) {
      this.iniciarNovoAtendimento(cliente);
    }

    /*
     * Garante que o telefone atual permaneça
     * controlado pelo sistema.
     */
    if (!this.resumoAtual) {
      this.resumoAtual = criarResumoVazio(cliente.telefone);
    }

    this.resumoAtual.telefone = cliente.telefone;

    this.recebeuTexto = true;

    const resumoBase = this.resumoAtual;

    /*
     * 1ª mensagem de texto depois do aviso de mídia: um "sim" curto ao
     * "posso te passar para um vendedor" é pedido de vendedor (mesma
     * resposta e observação do pedido explícito), sem chamar o Claude.
     * Qualquer outra mensagem segue a triagem normal.
     */
    const respostaAoAvisoMidia = this.aguardandoRespostaAvisoMidia;

    this.aguardandoRespostaAvisoMidia = false;

    if (respostaAoAvisoMidia && aceitouVendedorDoAvisoMidia(mensagem)) {
      return this.encaminharPorPedidoDoCliente(mensagem, resumoBase, agora);
    }

    /*
     * Guarda qual etapa estava aguardando
     * antes de processar a mensagem atual.
     */
    const etapaAnterior = this.etapaAtual;

    /*
     * Trata a resposta da pergunta anterior
     * antes de chamar o Claude.
     */
    if (!novoAtendimento && etapaAnterior) {
      if (clienteNaoSabeOuNaoQuerInformar(mensagem)) {
        this.etapasConcluidas.add(etapaAnterior);

        if (etapaAnterior === "observacoes" && semObservacoes(mensagem)) {
          this.resumoAtual.observacoes = "Nenhuma observação adicional.";
        }
      }
    }

    /*
     * Envia para o Claude somente o histórico
     * pertencente ao atendimento atual.
     *
     * O histórico antigo continua guardado,
     * mas não contamina a nova triagem.
     */
    const historicoDoAtendimento = this.historico.slice(
      this.indiceInicioAtendimento,
    );

    const contexto = [
      "Resumo atual do atendimento (JSON):",

      JSON.stringify(
        {
          nome: resumoBase.nome,

          telefone: resumoBase.telefone,

          produto: resumoBase.produto,

          quantidade: resumoBase.quantidade,

          observacoes: resumoBase.observacoes,
        },
        null,
        2,
      ),

      "",

      `Novo atendimento: ${novoAtendimento ? "SIM" : "NÃO"}`,

      "",

      `Última etapa aguardando resposta: ${etapaAnterior ?? "nenhuma"}`,

      "",

      "Mensagem atual do cliente:",

      mensagem,

      "",

      "Aproveite todas as informações fornecidas pelo cliente.",

      "Não invente informações.",

      "Não repita perguntas já respondidas.",

      "Faça no máximo uma pergunta.",
    ].join("\n");

    const resposta = await client.messages.parse({
      model: MODELO,

      max_tokens: 4096,

      /*
       * Cache da parte fixa (instruções e, antes delas, o schema da
       * saída): igual em toda chamada, é lida do cache por 0,1× do
       * preço. TTL de 5 min, renovado a cada leitura. A conversa fica
       * fora do cache (muda a cada mensagem).
       */
      system: [{ type: "text", text: INSTRUCOES, cache_control: { type: "ephemeral" } }],

      output_config: {
        effort: "medium",

        format: jsonSchemaOutputFormat(SCHEMA),
      },

      messages: [
        ...historicoDoAtendimento,

        {
          role: "user",

          content: contexto,
        },
      ],
    });

    /*
     * Medição de tokens por chamada.
     *
     * Somente dados técnicos: sem prompt,
     * resposta, histórico, telefone ou resumo.
     */
    const uso = resposta.usage;

    console.log(
      [
        "[Claude] uso",
        `atendimento: ${this.atendimentoId}`,
        `modelo: ${valorSeguro(resposta.model)}`,
        `input_tokens: ${uso.input_tokens}`,
        `output_tokens: ${uso.output_tokens}`,
        `cache_creation_input_tokens: ${uso.cache_creation_input_tokens ?? "-"}`,
        `cache_read_input_tokens: ${uso.cache_read_input_tokens ?? "-"}`,
        `service_tier: ${uso.service_tier ?? "-"}`,
      ].join(" | "),
    );

    const saida = resposta.parsed_output as SaidaClaude | null;

    if (!saida) {
      throw new Error(
        "O Claude não retornou um JSON válido no formato esperado.",
      );
    }

    const anterior = this.resumoAtual;

    /*
     * Pergunta que só o vendedor responde (estoque, preço, prazo,
     * pagamento...): a da Claude; sem ela, a reserva pelo texto.
     */
    /*
     * Produto com qualificador comercial e sem pergunta ("Lajotas em
     * promoção"): não é pergunta ao vendedor (a triagem segue).
     */
    const soQualificador = QUALIFICADOR_COMERCIAL.test(textoSemAcento(mensagem)) && !pareceFrasePergunta(mensagem);

    const tipoComercial = soQualificador ? null : lerPerguntaComercial(saida, mensagem);

    /*
     * Pedido de atendente (a Claude ou, de reserva, o texto): vai ao
     * vendedor na hora e nunca vira item, nome nem observação.
     */
    const pedidoAtendente = saida.pedido_atendente === true || pediuHumanoExplicitamente(mensagem);

    /*
     * Acompanhamento (orçamento ou pedido que já existe, cobrança de
     * retorno): também vai ao vendedor na hora, sem pedir nome.
     */
    const acompanhamento = saida.acompanhamento === true || pareceAcompanhamento(mensagem);

    const pedidoHumano = pedidoAtendente || acompanhamento;

    const linhasDaMensagem = mensagem.split("\n");

    const ehOPedido = (texto: string) =>
      pedidoHumano &&
      (mesmoTexto(texto, mensagem) ||
        linhasDaMensagem.some((linha) => mesmoTexto(texto, linha)) ||
        pediuHumanoExplicitamente(texto) ||
        /\b(atendente|vendedora?|humano|robo)\b/.test(textoSemAcento(texto)) ||
        (acompanhamento && (pareceAcompanhamento(texto) || /\b(orcamento|pedido)\b|\d{5,}/.test(textoSemAcento(texto)))));

    /*
     * Primeiro usamos as informações identificadas
     * pelo Claude.
     */
    const resumo: ResumoCliente = {
      nome: normalizarCampo(saida.resumo.nome, anterior.nome),

      telefone: cliente.telefone,

      produto: normalizarCampo(saida.resumo.produto, anterior.produto),

      quantidade: normalizarCampo(saida.resumo.quantidade, anterior.quantidade),

      observacoes: normalizarCampo(
        saida.resumo.observacoes,
        anterior.observacoes,
      ),
    };

    /*
     * O que não serve para o campo não entra: frase de pedido como nome,
     * intenção sem produto como produto ou observação, nome como produto.
     */
    /*
     * Etapa do nome: a Claude classifica a resposta (nome de pessoa,
     * produto ou outra coisa). "produto" e "outro" nunca viram nome;
     * "nome_pessoa" aceita nome que coincide com palavra de produto
     * ("Ferro Santos"). Sem classificação: a lista de reserva decide.
     */
    const classificacaoNome = !novoAtendimento && etapaAnterior === "nome" ? lerClassificacaoNome(saida.classificacao_resposta_nome) : null;

    const nomeDePessoa = classificacaoNome === "nome_pessoa";

    if (classificacaoNome === "produto" || classificacaoNome === "outro") {
      resumo.nome = anterior.nome;
    } else if (resumo.nome !== anterior.nome && campoPreenchido(resumo.nome) && naoEhNome(resumo.nome, nomeDePessoa)) {
      resumo.nome = anterior.nome;
    }

    if (resumo.produto !== anterior.produto && campoPreenchido(resumo.produto) && pareceIntencaoSemProduto(resumo.produto)) {
      resumo.produto = anterior.produto;
    }

    if (tipoComercial && resumo.produto !== anterior.produto && campoPreenchido(resumo.produto) && produtoEhPergunta(resumo.produto, mensagem, tipoComercial)) {
      resumo.produto = anterior.produto;
    }

    if (resumo.produto !== anterior.produto && ehOPedido(resumo.produto)) {
      resumo.produto = anterior.produto;
    }

    if (resumo.nome !== anterior.nome && ehOPedido(resumo.nome)) {
      resumo.nome = anterior.nome;
    }

    if (pedidoHumano && resumo.observacoes !== anterior.observacoes && (acompanhamento || /\b(atendente|vendedora?|humano|pessoa|robo)\b/.test(textoSemAcento(resumo.observacoes)))) {
      resumo.observacoes = anterior.observacoes;
    }

    if (resumo.observacoes !== anterior.observacoes && campoPreenchido(resumo.observacoes) && observacaoSoIntencao(resumo.observacoes)) {
      resumo.observacoes = anterior.observacoes;
    }

    /*
     * Itens do pedido: a lista do Claude (todos até agora) vira
     * produto/quantidade, uma linha por item. Sem intenção nem o nome do
     * cliente como item; quantidade já conhecida não se perde; item que
     * o Claude esqueceu volta (se nenhum novo o contém).
     */
    const itensClaude = lerItensDoClaude(saida.itens).filter(
      (item) =>
        !pareceIntencaoSemProduto(item.produto) &&
        !(campoPreenchido(resumo.nome) && mesmoTexto(item.produto, resumo.nome)) &&
        !(tipoComercial && produtoEhPergunta(item.produto, mensagem, tipoComercial)) &&
        !ehOPedido(item.produto),
    );

    if (itensClaude.length > 0) {
      const anteriores = itensDoResumo(anterior.produto, anterior.quantidade);

      const contem = (a: string, b: string) => chaveItem(a).includes(chaveItem(b)) || chaveItem(b).includes(chaveItem(a));

      const itens: ItemPedido[] = itensClaude.map((item) => ({
        produto: item.produto,
        quantidade: item.quantidade ?? anteriores.find((a) => mesmoTexto(a.produto, item.produto))?.quantidade ?? null,
      }));

      for (const antigo of anteriores) {
        if (!itens.some((item) => contem(item.produto, antigo.produto))) {
          itens.push(antigo);
        }
      }

      const campos = camposDosItens(itens);

      resumo.produto = campos.produto;

      resumo.quantidade = campos.quantidade;
    }

    /*
     * Agora aplicamos um fallback determinístico
     * para a etapa atual.
     *
     * Exemplo:
     *
     * Cliente responde "10 sacos"
     * etapa atual = quantidade
     *
     * Mesmo que o Claude retorne quantidade como
     * "Não informado", o sistema reconhece
     * "10 sacos" como quantidade.
     *
     * Um pedido explícito de atendimento humano
     * NÃO é resposta da etapa pendente.
     */
    /*
     * Etapa da quantidade respondida com medida ou especificação: a Claude
     * a põe no nome do item ("telhas" → "telhas 150x120"), nunca na
     * quantidade. Esses itens são perguntados de novo com outra frase, e
     * a resposta não vira quantidade pela reserva do texto.
     */
    const itensEspecificados =
      !novoAtendimento && etapaAnterior === "quantidade" && !tipoComercial && !pedidoHumano
        ? itensDoResumo(resumo.produto, resumo.quantidade).filter(
            (item) =>
              item.quantidade === null &&
              itensDoResumo(anterior.produto, anterior.quantidade).some(
                (antigo) => !mesmoTexto(antigo.produto, item.produto) && chaveItem(item.produto).includes(chaveItem(antigo.produto)),
              ),
          )
        : [];

    if (
      !novoAtendimento &&
      etapaAnterior &&
      !pedidoHumano &&
      itensEspecificados.length === 0 &&
      !clienteNaoSabeOuNaoQuerInformar(mensagem)
    ) {
      /*
       * Etapa do nome: com a classificação da Claude, "produto" e "outro"
       * não dão nome e "nome_pessoa" aceita palavra de produto no nome.
       */
      /*
       * Pergunta comercial não é resposta da etapa (nunca vira nome,
       * produto ou quantidade).
       */
      const respostaDireta =
        tipoComercial !== null
          ? null
          : etapaAnterior === "nome" && classificacaoNome !== null
          ? classificacaoNome === "nome_pessoa" && pareceNome(mensagem, true)
            ? mensagem.trim()
            : null
          : extrairRespostaDireta(etapaAnterior, mensagem);

      /*
       * Na etapa do nome, resposta que é produto vai para o produto (se o
       * Claude não pôs) e o nome é perguntado de novo. Decide a
       * classificação da Claude; sem ela, a lista de reserva.
       */
      const respostaEhProduto = tipoComercial === null && (classificacaoNome === "produto" || (classificacaoNome === null && pareceProduto(mensagem)));

      if (etapaAnterior === "nome" && !campoPreenchido(resumo.produto) && respostaEhProduto) {
        resumo.produto = mensagem.trim().replace(/\s+/g, " ");
      }

      /*
       * Resposta das observações que trouxe produto ou quantidade (o
       * Claude os pôs nos campos próprios): não é copiada para
       * observações, e a etapa conta como respondida.
       */
      const trouxeProduto =
        etapaAnterior === "observacoes" &&
        (resumo.produto !== anterior.produto || resumo.quantidade !== anterior.quantidade);

      if (trouxeProduto) {
        this.etapasConcluidas.add("observacoes");
      } else if (respostaDireta !== null && !campoPreenchido(resumo[etapaAnterior])) {
        /*
         * Fallback: só quando o Claude não
         * preencheu o campo.
         */
        resumo[etapaAnterior] = respostaDireta;
      }
    }

    /*
     * Qualificador comercial no nome de um item novo ("Lajotas em
     * promoção"): o item fica só com o produto e as observações dizem o
     * que o cliente procura ("Cliente procura lajotas em promoção.").
     */
    if (resumo.produto !== anterior.produto && campoPreenchido(resumo.produto)) {
      const antigos = itensDoResumo(anterior.produto, anterior.quantidade);

      let mudou = false;

      const itens = itensDoResumo(resumo.produto, resumo.quantidade).map((item) => {
        const limpo = antigos.some((a) => mesmoTexto(a.produto, item.produto)) ? null : produtoSemQualificador(item.produto);

        if (limpo === null) {
          return item;
        }

        mudou = true;

        resumo.observacoes = juntarObservacao(resumo.observacoes, `Cliente procura ${item.produto.charAt(0).toLowerCase()}${item.produto.slice(1)}.`);

        return { ...item, produto: limpo };
      });

      if (mudou) {
        const campos = camposDosItens(itens);

        resumo.produto = campos.produto;

        resumo.quantidade = campos.quantidade;
      }
    }

    /*
     * O nome do cliente nunca vira produto (nem pelo Claude, nem pelo
     * fallback da etapa produto).
     */
    if (campoPreenchido(resumo.nome) && campoPreenchido(resumo.produto) && mesmoTexto(resumo.produto, resumo.nome) && !mesmoTexto(anterior.produto, resumo.nome)) {
      resumo.produto = anterior.produto;
    }

    /*
     * Perguntou se a loja tem o produto: o sistema registra a pergunta
     * (a da Claude sobre o mesmo assunto sai) e o atendimento vai ao
     * vendedor assim que tiver o nome. Outras perguntas vão para as
     * observações pela Claude; se ela não registrou, vai a mensagem.
     */
    const disponibilidadeAgora = tipoComercial === "disponibilidade" && campoPreenchido(resumo.produto);

    if (disponibilidadeAgora) {
      if (resumo.observacoes !== anterior.observacoes && /\b(tem|estoque|disponib\w*)\b/.test(textoSemAcento(resumo.observacoes))) {
        resumo.observacoes = anterior.observacoes;
      }

      const todos = itensDoResumo(resumo.produto, resumo.quantidade);

      const novos = todos.filter((item) => !itensDoResumo(anterior.produto, anterior.quantidade).some((a) => mesmoTexto(a.produto, item.produto)));

      resumo.observacoes = juntarObservacao(
        resumo.observacoes,
        `${OBSERVACAO_DISPONIBILIDADE}${listarEmTexto((novos.length > 0 ? novos : todos).map((item) => item.produto))}.`,
      );

      this.perguntouDisponibilidade = true;
    } else if (tipoComercial && tipoComercial !== "geral" && !campoPreenchido(anterior.observacoes) && resumo.observacoes === anterior.observacoes) {
      resumo.observacoes = `Cliente perguntou: "${mensagem.replace(/\s+/g, " ").trim().slice(0, 200)}"`;
    }

    /*
     * Observações negativas recebem valor explícito.
     */
    if (
      !novoAtendimento &&
      etapaAnterior === "observacoes" &&
      semObservacoes(mensagem)
    ) {
      resumo.observacoes = "Nenhuma observação adicional.";

      this.etapasConcluidas.add("observacoes");
    }

    /*
     * Nome tem no máximo MAX_CARACTERES_NOME
     * (atendimentos.nome é VARCHAR(150)).
     */
    resumo.nome = limitarNome(resumo.nome);

    /*
     * Guarda o resumo atual dentro da instância.
     */
    this.resumoAtual = resumo;

    /*
     * Marca campos preenchidos automaticamente.
     */
    marcarEtapasPreenchidas(resumo, this.etapasConcluidas);

    /*
     * Quantidade é opcional: não perguntamos
     * quando não faz sentido para o pedido.
     */
    /*
     * "Quantidade não se aplica" só vale com um produto de verdade.
     */
    if (saida.quantidade_aplicavel === false && campoPreenchido(resumo.produto)) {
      if (!this.etapasConcluidas.has("quantidade")) {
        this.quantidadeNaoAplicavel = true;
      }

      this.etapasConcluidas.add("quantidade");
    }

    this.variosItens = saida.varios_itens === true;

    /*
     * Itens novos depois da etapa da quantidade, sem quantidade: UMA
     * pergunta só deles. A lista de conhecidos é tirada quando a etapa
     * fecha (o item citado junto da resposta da quantidade fica de fora).
     */
    const itensAgora = itensDoResumo(resumo.produto, resumo.quantidade);

    const itensSemQuantidade = this.itensNaQuantidade
      ? itensAgora.filter(
          (item) => item.quantidade === null && !this.itensNaQuantidade!.has(chaveItem(item.produto)) && !this.quantidadePerguntadaDe.has(chaveItem(item.produto)),
        )
      : [];

    if (this.itensNaQuantidade === null && this.etapasConcluidas.has("quantidade")) {
      this.itensNaQuantidade = new Set(itensAgora.map((item) => chaveItem(item.produto)));
    }

    /*
     * Etapa ainda sem resposta válida depois do
     * máximo de perguntas: pula para a próxima.
     */
    for (const etapa of ORDEM_ETAPAS) {
      if (
        !this.etapasConcluidas.has(etapa) &&
        (this.perguntasPorEtapa.get(etapa) ?? 0) >= MAX_PERGUNTAS_POR_ETAPA
      ) {
        this.etapasConcluidas.add(etapa);

        console.log(
          `Atendimento ${this.atendimentoId}: etapa ${etapa} pulada após ${MAX_PERGUNTAS_POR_ETAPA} perguntas sem resposta válida.`,
        );
      }
    }

    /*
     * Situações especiais.
     *
     * pedidoHumano já foi detectado acima.
     */
    const risco = assuntoDeRisco(mensagem);

    /*
     * Descobre a próxima etapa.
     */
    const proximaEtapa = encontrarProximaEtapa(this.etapasConcluidas);

    const triagemConcluida = proximaEtapa === null;

    /*
     * Produto só como categoria: UMA pergunta pelos itens antes de
     * seguir (inclusive no lugar do fim da triagem). Depois do nome,
     * nunca com pedido de vendedor ou assunto de risco.
     */
    /*
     * Perguntou se a loja tem o produto e já tem o nome (ou o nome foi
     * pulado): direto ao vendedor. Pergunta comercial na etapa do
     * produto sem nenhum produto: também (a pergunta vai nas
     * observações, "Itens: Não informado").
     */
    const encaminharDisponibilidade = this.perguntouDisponibilidade && (campoPreenchido(resumo.nome) || this.etapasConcluidas.has("nome"));

    const perguntaSemProduto =
      tipoComercial !== null && !disponibilidadeAgora && !novoAtendimento && etapaAnterior === "produto" && !campoPreenchido(resumo.produto);

    const perguntarItens =
      !this.perguntouDisponibilidade &&
      !perguntaSemProduto &&
      !this.perguntouItens &&
      saida.produto_generico === true &&
      campoPreenchido(resumo.produto) &&
      !pedidoHumano &&
      !risco &&
      proximaEtapa !== "nome";

    const perguntarQuantidadeNovos =
      !perguntarItens && !this.perguntouDisponibilidade && !perguntaSemProduto && itensSemQuantidade.length > 0 && !pedidoHumano && !risco && proximaEtapa !== "nome";

    let status: StatusAtendimento = "IA";

    if (pedidoHumano) {
      status = "HUMANO";
    } else if (risco) {
      status = "HUMANO";
    } else if (encaminharDisponibilidade || perguntaSemProduto) {
      status = "HUMANO";
    } else if (triagemConcluida && !perguntarItens && !perguntarQuantidadeNovos) {
      status = "HUMANO";
    }

    let respostaTexto = saida.resposta.trim();

    /*
     * A apresentação acompanha a primeira resposta
     * que de fato chegar ao cliente.
     */
    const incluirApresentacao = this.apresentacaoPendente;

    /*
     * Perguntas da triagem: apresentação (se pendente), "Certo, {nome}!"
     * (ou "Certo!", em dúvida) no turno em que o nome chegou e o aviso de
     * estoque/preço/prazo, se o cliente perguntou.
     */
    const nomeChegou = !campoPreenchido(anterior.nome) && campoPreenchido(resumo.nome);

    const primeiroNome = nomeChegou ? primeiroNomeConfiavel(resumo.nome, nomeDePessoa) : null;

    const confirmacaoNome = nomeChegou ? (primeiroNome ? `Certo, ${primeiroNome}!` : "Certo!") : null;

    /*
     * Na etapa do nome veio produto e nenhum nome: anota e pede o nome.
     */
    const anotouProduto =
      !novoAtendimento &&
      etapaAnterior === "nome" &&
      !campoPreenchido(resumo.nome) &&
      campoPreenchido(resumo.produto) &&
      resumo.produto !== anterior.produto;

    const avisoComercial = tipoComercial ? AVISOS_PERGUNTA_COMERCIAL[tipoComercial] : null;

    const montarPergunta = (pergunta: string) => {
      let corpo = avisoComercial ? `${avisoComercial}\n\n${pergunta}` : pergunta;

      if (confirmacaoNome) {
        corpo = `${confirmacaoNome} ${corpo}`;
      }

      return incluirApresentacao ? `${MENSAGEM_INICIAL}\n\n${corpo}` : corpo;
    };

    let repeteNomeComAviso = false;

    /*
     * Quando o atendimento é humano,
     * encerramos a etapa atual.
     */
    if (status === "HUMANO") {
      this.etapaAtual = null;

      /*
       * Com pergunta comercial, o aviso antes; pela disponibilidade, o
       * "Certo, {nome}!" no lugar do "Perfeito!".
       */
      let corpo = pedidoHumano ? RESPOSTA_PEDIDO_ATENDENTE : gerarRespostaHumano();

      if (avisoComercial) {
        corpo = `${avisoComercial}\n\n${corpo}`;
      }

      if (!pedidoHumano && encaminharDisponibilidade && confirmacaoNome) {
        corpo = `${confirmacaoNome} ${corpo.replace("Perfeito! ", "")}`;
      }

      respostaTexto = incluirApresentacao ? `${MENSAGEM_INICIAL}\n\n${corpo}` : corpo;

      if (acompanhamento) {
        resumo.observacoes = juntarObservacao(resumo.observacoes, observacaoAcompanhamento(mensagem));
      } else if (pedidoAtendente) {
        resumo.observacoes = juntarObservacao(resumo.observacoes, observacaoPedidoAtendente(mensagem));
      }

      if (
        risco &&
        !resumo.observacoes.toLowerCase().includes("assunto de risco")
      ) {
        resumo.observacoes =
          resumo.observacoes === NAO_INFORMADO
            ? "Atendimento encaminhado para humano por envolver assunto de risco."
            : `${resumo.observacoes} Atendimento encaminhado para humano por envolver assunto de risco.`;
      }

      resumo.observacoes = this.anexarLegendas(resumo.observacoes);
    } else if (perguntarItens) {
      const pergunta = perguntaDosItens(saida.pergunta_itens);

      this.perguntouItens = true;

      this.etapaAtual = "produto";

      respostaTexto = montarPergunta(pergunta);

      console.log(`Atendimento ${this.atendimentoId}: produto só como categoria; perguntando pelos itens.`);
    } else if (perguntarQuantidadeNovos) {
      for (const item of itensSemQuantidade) {
        this.quantidadePerguntadaDe.add(chaveItem(item.produto));
      }

      this.etapaAtual = "quantidade";

      respostaTexto = montarPergunta(
        `Qual a quantidade de ${listarEmTexto(itensSemQuantidade.map((item) => item.produto))}? Se ainda não souber, sem problema.`,
      );

      console.log(`Atendimento ${this.atendimentoId}: ${itensSemQuantidade.length} item(ns) novo(s) depois da quantidade; perguntando a quantidade.`);
    } else if (proximaEtapa) {
      /*
       * A pergunta é controlada pelo sistema.
       *
       * Isso impede o modelo de pular etapas
       * ou repetir uma pergunta que não corresponde
       * à etapa atual.
       */
      const jaPerguntada = (this.perguntasPorEtapa.get(proximaEtapa) ?? 0) > 0;

      /*
       * Pergunta comercial na etapa do nome: o aviso e o nome de novo,
       * com naturalidade (sem "não consegui identificar" e sem contar
       * como tentativa).
       */
      repeteNomeComAviso = proximaEtapa === "nome" && !anotouProduto && avisoComercial !== null && jaPerguntada;

      /*
       * "ok", "certo", "tá" e a mesma etapa continua: variação curta (não
       * repete a pergunta idêntica).
       */
      const variacao = !novoAtendimento && etapaAnterior === proximaEtapa && mensagemSemInformacao(mensagem) && !avisoComercial;

      const pergunta =
        proximaEtapa === "nome" && anotouProduto
          ? `Anotei ${listarEmTexto(itensDoResumo(resumo.produto, resumo.quantidade).map((item) => item.produto))}! E qual é o seu nome?`
          : repeteNomeComAviso
            ? "E qual é o seu nome?"
            : proximaEtapa === "quantidade" && itensEspecificados.length > 0
              ? `Certo, ${listarEmTexto(itensEspecificados.map((item) => item.produto))}. E quantas você precisa? Se ainda não souber, sem problema.`
              : variacao
                ? VARIACAO_DA_ETAPA[proximaEtapa]
                : perguntaDaEtapa(proximaEtapa, resumo, this.variosItens, jaPerguntada);

      this.etapaAtual = proximaEtapa;

      if (!repeteNomeComAviso) {
        this.perguntasPorEtapa.set(proximaEtapa, (this.perguntasPorEtapa.get(proximaEtapa) ?? 0) + 1);
      }

      /*
       * Novo atendimento:
       * sempre apresenta a assistente antes
       * da primeira pergunta da triagem.
       */
      respostaTexto = montarPergunta(pergunta);
    }

    /*
     * Segurança para resposta vazia.
     */
    if (respostaTexto === "") {
      respostaTexto = "Pode me contar um pouco mais sobre o que você precisa?";
    }

    /*
     * Notas repetidas sobre o mesmo produto viram uma só.
     */
    resumo.observacoes = unirNotasRepetidas(resumo.observacoes);

    /*
     * IMPORTANTE:
     *
     * Guardamos exatamente o que o cliente recebeu.
     *
     * Antes estávamos guardando resposta.content,
     * que podia ser diferente da pergunta realmente enviada.
     */
    this.historico.push(
      {
        role: "user",

        content: mensagem,
      },

      {
        role: "assistant",

        content: respostaTexto,
      },
    );

    /*
     * Registra o turno para poder desfazê-lo
     * se o envio desta resposta falhar.
     */
    const apresentacaoNaResposta =
      incluirApresentacao && respostaTexto.startsWith(MENSAGEM_INICIAL);

    if (apresentacaoNaResposta) {
      this.apresentacaoPendente = false;
    }

    this.ultimoTurno = {
      indiceResposta: this.historico.length - 1,

      incluiuApresentacao: apresentacaoNaResposta,

      etapaPerguntada: status === "IA" && !perguntarItens && !perguntarQuantidadeNovos && !repeteNomeComAviso ? proximaEtapa : null,

      midia: false,
    };

    /*
     * Atualiza o momento da última atividade
     * somente depois de finalizar o processamento.
     */
    this.ultimaMensagemEm = agora;

    return {
      resposta: respostaTexto,

      status,

      resumo,
    };
  }

  /**
   * Cliente aceitou o vendedor oferecido no aviso de mídia: o mesmo
   * resultado do pedido explícito de humano (resposta e observação).
   */
  private encaminharPorPedidoDoCliente(mensagem: string, resumoAtual: ResumoCliente, agora: number): ResultadoIA {
    const resumo: ResumoCliente = { ...resumoAtual };

    resumo.observacoes = juntarObservacao(resumo.observacoes, OBSERVACAO_PEDIU_ATENDENTE);

    resumo.observacoes = this.anexarLegendas(resumo.observacoes);

    this.resumoAtual = resumo;

    this.etapaAtual = null;

    const incluirApresentacao = this.apresentacaoPendente;

    const resposta = incluirApresentacao ? `${MENSAGEM_INICIAL}\n\n${gerarRespostaHumano()}` : gerarRespostaHumano();

    this.historico.push({ role: "user", content: mensagem }, { role: "assistant", content: resposta });

    this.apresentacaoPendente = false;

    this.ultimoTurno = {
      indiceResposta: this.historico.length - 1,

      incluiuApresentacao: incluirApresentacao,

      etapaPerguntada: null,

      midia: false,
    };

    this.ultimaMensagemEm = agora;

    console.log(`Atendimento ${this.atendimentoId}: cliente aceitou o vendedor oferecido no aviso de mídia; atendimento para HUMANO.`);

    return { resposta, status: "HUMANO", resumo };
  }

  /**
   * Legendas do atendimento nas observações (para o vendedor ver).
   * Também usada pelo webhook quando força HUMANO (falha de envio
   * ou da IA).
   */
  anexarLegendas(observacoes: string): string {
    let resultado = observacoes;

    for (const { rotulo, legenda } of this.legendas) {
      resultado = anexarObservacao(resultado, `Cliente enviou ${rotulo} com a legenda: "${legenda}".`);
    }

    return resultado;
  }

  /**
   * Mídia do cliente (B7). Não chama o Claude e não muda a etapa:
   *
   * - 1ª mídia do atendimento: aviso (com a apresentação, se ainda
   *   pendente; a apresentação conta como entregue);
   * - até 30 s depois da que gerou o aviso: mesmo envio, nada a enviar
   *   (resposta vazia);
   * - depois disso: HUMANO, com a observação e as legendas no resumo.
   *
   * A mídia (e a legenda) entra no histórico como mensagem do cliente.
   * Log só com o tipo, se tinha legenda e o código do atendimento.
   */
  async responderMidia(midia: MidiaRecebida, cliente: Cliente, recebidaEm: number): Promise<ResultadoIA> {
    const agora = Date.now();

    this.ultimoTurno = null;

    if (!this.atendimentoIniciado || this.estaInativa(agora)) {
      this.iniciarNovoAtendimento(cliente);
    }

    if (!this.resumoAtual) {
      this.resumoAtual = criarResumoVazio(cliente.telefone);
    }

    this.resumoAtual.telefone = cliente.telefone;

    if (midia.legenda) {
      this.legendas.push({ rotulo: ROTULOS_MIDIA[midia.tipo], legenda: midia.legenda });
    }

    this.midiasRecebidas.push(ROTULOS_MIDIA[midia.tipo]);

    this.historico.push({ role: "user", content: textoDaMidia(midia) });

    this.ultimaMensagemEm = agora;

    const resumo = this.resumoAtual;

    const registrar = (acao: string) =>
      console.log(
        `Atendimento ${this.atendimentoId}: mídia ${midia.tipo} (legenda: ${midia.legenda ? "sim" : "não"}) | ${acao}`,
      );

    /*
     * Mesmo envio da mídia que gerou o aviso: nada a enviar.
     */
    if (this.avisoMidiaEm !== null && this.avisoMidiaEm > 0 && recebidaEm - this.avisoMidiaEm <= JANELA_MESMO_ENVIO_MS) {
      registrar("mesmo envio da anterior; sem nova resposta");

      return { resposta: "", status: "IA", resumo: { ...resumo } };
    }

    const incluirApresentacao = this.apresentacaoPendente;

    let resposta: string;

    let status: StatusAtendimento;

    if (this.avisoMidiaEm !== null) {
      /*
       * Mídia de novo depois do aviso: vendedor.
       */
      status = "HUMANO";

      this.etapaAtual = null;

      resumo.observacoes = this.anexarLegendas(anexarObservacao(resumo.observacoes, OBSERVACAO_MIDIA));

      resposta = incluirApresentacao ? `${MENSAGEM_INICIAL}\n\n${gerarRespostaHumano()}` : gerarRespostaHumano();

      registrar("de novo depois do aviso; atendimento para HUMANO");
    } else {
      status = "IA";

      this.avisoMidiaEm = recebidaEm;

      this.aguardandoRespostaAvisoMidia = true;

      if (incluirApresentacao) {
        resposta = `${MENSAGEM_INICIAL}\n\n${AVISO_MIDIA_INICIO}`;
      } else {
        resposta = midia.legenda ? AVISO_MIDIA_COM_LEGENDA : AVISO_MIDIA_SEM_LEGENDA;
      }

      registrar("aviso de mídia");
    }

    this.historico.push({ role: "assistant", content: resposta });

    this.apresentacaoPendente = false;

    this.ultimoTurno = {
      indiceResposta: this.historico.length - 1,

      incluiuApresentacao: incluirApresentacao,

      etapaPerguntada: null,

      midia: true,
    };

    return { resposta, status, resumo: { ...resumo } };
  }
}
