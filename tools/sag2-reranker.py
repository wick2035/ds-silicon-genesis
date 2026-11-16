"""Local SAG2-style evidence scoring. Only local model files are read."""
import json
import os
import sys
import hashlib

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
os.environ['USE_TF'] = '0'

def send(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)

try:
    model_path = sys.argv[1]
    # Qwen/Qwen3-Reranker-0.6B, revision e61197ed45024b0ed8a2d74b80b4d909f1255473.
    with open(os.path.join(model_path, 'model.safetensors'), 'rb') as weights:
        if hashlib.file_digest(weights, 'sha256').hexdigest() != '27cd75a405b9c1b46b59abfd88aaa209e6fed2a1972cde9b70e7659537c5e65b':
            raise ValueError('unexpected model revision')
    import torch
    # Transformers 4.54 checks this type during initialization even when Qwen3
    # uses its own RMSNorm. Older local PyTorch builds do not expose the name.
    if not hasattr(torch.nn, 'RMSNorm'):
        class _UnusedRMSNorm(torch.nn.Module):
            pass
        torch.nn.RMSNorm = _UnusedRMSNorm
    import transformers.utils.import_utils as import_utils
    import_utils._timm_available = False  # text-only inference needs no image stack
    from transformers import AutoTokenizer
    from transformers.models.qwen3.modeling_qwen3 import Qwen3ForCausalLM
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    tokenizer = AutoTokenizer.from_pretrained(model_path, local_files_only=True, padding_side='left')
    model = Qwen3ForCausalLM.from_pretrained(model_path, local_files_only=True,
        torch_dtype=torch.float16 if device == 'cuda' else torch.float32).to(device).eval()
    prefix = tokenizer.encode('<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n', add_special_tokens=False)
    suffix = tokenizer.encode('<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n', add_special_tokens=False)
    no, yes = tokenizer.convert_tokens_to_ids('no'), tokenizer.convert_tokens_to_ids('yes')
    send({'ready': True, 'device': device})
except Exception:
    send({'ready': False, 'error': '本地重排模型不可用'})
    sys.exit(1)

for line in sys.stdin:
    try:
        request = json.loads(line)
        query = str(request['query'])[:500]
        docs = request['documents'][:24]
        scores = []
        for doc in docs:
            text = '<Instruct>: 判断这段历史是否有助于回答当前对话。\n<Query>: ' + query + '\n<Document>: ' + str(doc)[:1200]
            ids = prefix + tokenizer.encode(text, add_special_tokens=False) + suffix
            inputs = torch.tensor([ids], device=device)
            with torch.inference_mode():
                logits = model(input_ids=inputs, use_cache=False, logits_to_keep=1).logits[0, -1, [no, yes]].float()
                scores.append(float(torch.softmax(logits, dim=-1)[1]))
        send({'id': request['id'], 'scores': scores})
    except Exception:
        send({'id': request.get('id'), 'error': '本地重排失败'})
